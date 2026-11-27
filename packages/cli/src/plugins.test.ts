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

describe('site CLI plugin auditChecks and verifyChecks hooks', () => {
  async function createMinimalArchiveRepo(dir: string, plugins?: string[]): Promise<void> {
    const dataDir = path.join(dir, 'data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dir, 'kinloom.config.yaml'), makeSampleSiteConfigYaml(plugins), 'utf8');
    await writeFile(
      path.join(dataDir, 'people.yaml'),
      `- id: per_ada_alder
  slug: ada-alder
  full_name: Ada Alder
  given_name: Ada
  surname: Alder
  alt_names: []
  sex: F
  is_living: false
  lineage_group: ancestor
  birth_edtf: '1850-01-01'
  death_edtf: '1920-02-02'
  portrait_url: null
  pronunciation:
    phonetic: AY-duh AWL-der
    ipa: /ˈeɪdə ˈɔːldər/
    source_label: Synthetic test fixture
`,
      'utf8'
    );
    await writeFile(path.join(dataDir, 'places.yaml'), '[]\n', 'utf8');
    await writeFile(path.join(dataDir, 'sources.yaml'), '[]\n', 'utf8');
    await writeFile(path.join(dataDir, 'events.yaml'), '[]\n', 'utf8');
    await writeFile(path.join(dataDir, 'kinship.yaml'), '[]\n', 'utf8');
    await writeFile(path.join(dataDir, 'media.yaml'), '[]\n', 'utf8');
    await writeFile(path.join(dataDir, 'narratives.yaml'), '[]\n', 'utf8');
  }

  it('auto-discovers check-only plugins from extensions/*/cli.mjs and runs verifyChecks and auditChecks', async () => {
    const siteDir = await makeTempDir('kinloom-plugin-checks-');
    await createMinimalArchiveRepo(siteDir);

    const extDir = path.join(siteDir, 'extensions', 'custom-checks');
    await mkdir(extDir, { recursive: true });
    await writeFile(
      path.join(extDir, 'cli.mjs'),
      `export default {
  id: 'custom-checks',
  name: 'Custom Checks',
  verifyChecks: [
    {
      id: 'require-source-count',
      name: 'Require Source Count',
      run(ctx) {
        if (ctx.sources.length === 0) {
          return {
            warnings: ['Archive has no sources yet.'],
            strictFailures: ['Strict mode requires at least one source.'],
          };
        }
        return {};
      },
    },
  ],
  auditChecks: [
    {
      id: 'require-summary',
      name: 'Require Narrative Summary',
      run(ctx) {
        const narratives = Array.isArray(ctx.patch.narratives) ? ctx.patch.narratives : [];
        if (narratives.length === 0) {
          return {
            errors: ['Patch must include at least one narrative.'],
          };
        }
        return { details: { checkedNarratives: narratives.length } };
      },
    },
  ],
};
`,
      'utf8'
    );

    // Check-only plugin should be discovered even without commands.
    const discovered = await discoverSiteCliPlugins(siteDir);
    expect(discovered.warnings).toEqual([]);
    expect(discovered.plugins).toHaveLength(1);
    expect(discovered.plugins[0]?.id).toBe('custom-checks');

    // Default verify surfaces plugin warning without failing.
    const verifyCap = createCaptureIo();
    expect(await runCli(['verify', '--repo', siteDir, '--json'], { cwd: siteDir, io: verifyCap.io })).toBe(
      EXIT_OK
    );
    const verifyJson = JSON.parse(verifyCap.stdout.join('\n')) as {
      ok: boolean;
      warnings: string[];
      pluginChecks: Array<{
        pluginId: string;
        id: string;
        ok: boolean;
        strictOk: boolean;
        warnings: string[];
      }>;
    };
    expect(verifyJson.ok).toBe(true);
    expect(verifyJson.pluginChecks).toHaveLength(1);
    expect(verifyJson.pluginChecks[0]?.id).toBe('require-source-count');
    expect(verifyJson.pluginChecks[0]?.strictOk).toBe(false);
    expect(verifyJson.warnings.some((w) => w.includes('[plugin:require-source-count]'))).toBe(true);

    // Verify with --strict promotes plugin strictFailures to errors.
    const strictVerifyCap = createCaptureIo();
    expect(
      await runCli(['verify', '--repo', siteDir, '--strict', '--json'], {
        cwd: siteDir,
        io: strictVerifyCap.io,
      })
    ).toBe(EXIT_ERROR);
    const strictVerifyJson = JSON.parse(strictVerifyCap.stdout.join('\n')) as {
      ok: boolean;
      errors: string[];
    };
    expect(strictVerifyJson.ok).toBe(false);
    expect(strictVerifyJson.errors.some((e) => e.includes('plugin(require-source-count)'))).toBe(true);

    // Audit runs plugin auditChecks and fails when plugin reports an error.
    const pkgDir = path.join(siteDir, 'research', 'people', 'per_ada_alder');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      path.join(pkgDir, 'patch.json'),
      JSON.stringify({ person_id: 'per_ada_alder', narratives: [] }, null, 2),
      'utf8'
    );
    const auditCap = createCaptureIo();
    expect(
      await runCli(['audit', 'per_ada_alder', '--repo', siteDir, '--json'], { cwd: siteDir, io: auditCap.io })
    ).toBe(EXIT_ERROR);
    const auditJson = JSON.parse(auditCap.stdout.join('\n')) as {
      ok: boolean;
      errors: string[];
      pluginChecks: Array<{ pluginId: string; id: string; ok: boolean; errors: string[] }>;
    };
    expect(auditJson.ok).toBe(false);
    expect(auditJson.pluginChecks).toHaveLength(1);
    expect(auditJson.pluginChecks[0]?.id).toBe('require-summary');
    expect(auditJson.errors.some((e) => e.includes('plugin(require-summary)'))).toBe(true);
  });

  it('catches throwing plugin checks cleanly and warns on duplicate check IDs', async () => {
    const siteDir = await makeTempDir('kinloom-plugin-throws-');
    await createMinimalArchiveRepo(siteDir);

    const pluginA: KinloomCliPlugin = {
      id: 'plugin-a',
      name: 'Plugin A',
      verifyChecks: [
        {
          id: 'dup-check',
          name: 'Boom Check',
          run() {
            throw new Error('simulated plugin failure');
          },
        },
      ],
    };
    const pluginB: KinloomCliPlugin = {
      id: 'plugin-b',
      name: 'Plugin B',
      verifyChecks: [
        {
          id: 'dup-check',
          name: 'Shadowed Check',
          run() {
            return { errors: [], warnings: [] };
          },
        },
      ],
    };

    const verifyCap = createCaptureIo();
    expect(
      await runCli(['verify', '--repo', siteDir, '--json'], {
        cwd: siteDir,
        io: verifyCap.io,
        plugins: [pluginA, pluginB],
      })
    ).toBe(EXIT_ERROR);
    const verifyJson = JSON.parse(verifyCap.stdout.join('\n')) as {
      ok: boolean;
      errors: string[];
      warnings: string[];
      pluginChecks: Array<{ pluginId: string; id: string; ok: boolean; errors: string[] }>;
    };
    expect(verifyJson.ok).toBe(false);
    expect(verifyJson.pluginChecks).toHaveLength(1);
    expect(verifyJson.pluginChecks[0]?.errors[0]).toContain('simulated plugin failure');
    expect(verifyJson.warnings.some((w) => w.includes("duplicate verify check 'dup-check'"))).toBe(true);
  });
});
