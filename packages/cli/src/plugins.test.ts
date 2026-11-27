import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type Place,
  type RawPerson,
  serializeEventsYaml,
  serializeKinloomConfigYaml,
  serializeKinshipYaml,
  serializeMediaYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
  serializePlacesYaml,
  serializeSourcesYaml,
} from '@kinloom/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type CliIo, runCli } from './cli.js';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from './errors.js';
import {
  CliPluginValidationError,
  discoverSiteCliPlugins,
  type KinloomCliCommand,
  type KinloomCliPlugin,
  resolvePluginCommands,
} from './plugins.js';

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

  it('fails fast when a plugin attempts to shadow a built-in command like verify', async () => {
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

    await expect(discoverSiteCliPlugins(siteDir)).rejects.toThrow(CliPluginValidationError);
    await expect(discoverSiteCliPlugins(siteDir)).rejects.toThrow(
      /collides with built-in CLI command 'verify'/
    );

    const verifyHelpCap = createCaptureIo();
    expect(await runCli(['verify', '--help'], { cwd: siteDir, io: verifyHelpCap.io })).toBe(EXIT_USAGE);
    expect(verifyHelpCap.stdout).toEqual([]);
    expect(verifyHelpCap.stderr.join('\n')).toContain("collides with built-in CLI command 'verify'");
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

  it('supports explicit options.plugins and fails fast on duplicate plugin IDs, duplicate commands, reserved checks, or empty identifiers', async () => {
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
        plugins: [explicitPlugin],
      })
    ).toBe(EXIT_OK);
    expect(pingCap.stdout).toEqual(['pong']);
    expect(pingCap.stderr).toEqual([]);

    const dupCap = createCaptureIo();
    expect(
      await runCli(['ping'], {
        cwd: emptyDir,
        io: dupCap.io,
        plugins: [explicitPlugin, explicitPlugin],
      })
    ).toBe(EXIT_USAGE);
    expect(dupCap.stdout).toEqual([]);
    expect(dupCap.stderr.join('\n')).toContain("Duplicate CLI plugin id 'explicit-plugin'");

    const failCap = createCaptureIo();
    expect(
      await runCli(['fail-cmd'], {
        cwd: emptyDir,
        io: failCap.io,
        plugins: [explicitPlugin],
      })
    ).toBe(EXIT_ERROR);

    const noopCommand: KinloomCliCommand = {
      name: 'custom-cmd',
      summary: 'Noop',
      help: 'Usage: kinloom custom-cmd',
      run: () => EXIT_OK,
    };

    expect(() => resolvePluginCommands([{ id: '   ', name: 'Blank', commands: [noopCommand] }])).toThrow(
      RangeError
    );
    expect(() =>
      resolvePluginCommands([
        {
          id: 'blank-cmd',
          name: 'Blank Cmd',
          commands: [{ ...noopCommand, name: '   ' }],
        },
      ])
    ).toThrow(CliPluginValidationError);
    expect(() =>
      resolvePluginCommands([
        { id: 'cmd-a', name: 'A', commands: [noopCommand] },
        { id: 'cmd-b', name: 'B', commands: [noopCommand] },
      ])
    ).toThrow(/duplicate command 'custom-cmd'/);
    expect(() =>
      resolvePluginCommands([
        {
          id: 'blank-audit',
          name: 'Blank Audit',
          auditChecks: [{ id: ' ', name: 'Blank', run: () => ({ errors: [], warnings: [] }) }],
        },
      ])
    ).toThrow(CliPluginValidationError);
    expect(() =>
      resolvePluginCommands([
        {
          id: 'blank-verify',
          name: 'Blank Verify',
          verifyChecks: [{ id: '', name: 'Blank', run: () => ({ errors: [], warnings: [] }) }],
        },
      ])
    ).toThrow(CliPluginValidationError);
    expect(() =>
      resolvePluginCommands([
        {
          id: 'reserved-audit',
          name: 'Reserved Audit',
          auditChecks: [{ id: 'pronunciation', name: 'Shadow', run: () => ({ errors: [], warnings: [] }) }],
        },
      ])
    ).toThrow(/reserved built-in audit check 'pronunciation'/);
    expect(() =>
      resolvePluginCommands([
        {
          id: 'reserved-verify',
          name: 'Reserved Verify',
          verifyChecks: [{ id: 'pronunciation', name: 'Shadow', run: () => ({ errors: [], warnings: [] }) }],
        },
      ])
    ).toThrow(/reserved built-in verify check 'pronunciation'/);
    expect(() =>
      resolvePluginCommands([
        {
          id: 'dup-verify-a',
          name: 'Dup Verify A',
          verifyChecks: [{ id: 'same-verify', name: 'A', run: () => ({ errors: [], warnings: [] }) }],
        },
        {
          id: 'dup-verify-b',
          name: 'Dup Verify B',
          verifyChecks: [{ id: 'same-verify', name: 'B', run: () => ({ errors: [], warnings: [] }) }],
        },
      ])
    ).toThrow(/duplicate verify check 'same-verify'/);
  });
});

async function createMinimalCheckArchive(options?: {
  plugins?: string[];
  people?: RawPerson[];
  places?: Place[];
  pronunciations?: Record<
    string,
    { phonetic?: string; ipa?: string; source_label?: string; source_url?: string }
  >;
}): Promise<string> {
  const siteDir = await makeTempDir('kinloom-plugin-checks-');
  const dataDir = path.join(siteDir, 'data');
  await mkdir(dataDir, { recursive: true });

  const configYaml = serializeKinloomConfigYaml({
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
        lineageGroups: ['ancestor', 'descendant'],
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
    ...(options?.plugins ? { plugins: options.plugins } : {}),
    ...(options?.pronunciations ? { pronunciations: options.pronunciations } : {}),
  });

  const people: RawPerson[] = options?.people ?? [
    {
      id: 'per_arthur_alder',
      slug: 'arthur-alder',
      full_name: 'Arthur Alder',
      given_name: 'Arthur',
      surname: 'Alder',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1858-04-12',
      death_edtf: '1932-09-18',
      portrait_url: null,
    },
  ];
  const places: Place[] = options?.places ?? [
    {
      id: 'plc_oak_county',
      slug: 'oak-county',
      name: 'Oak County',
      full_name: 'Oak County, Ohio, USA',
      place_type: 'county',
      parent_id: null,
      lat: 40.25,
      lng: -82.85,
      historical_names: [],
    },
  ];

  await Promise.all([
    writeFile(path.join(siteDir, 'kinloom.config.yaml'), configYaml, 'utf8'),
    writeFile(path.join(dataDir, 'people.yaml'), serializePeopleYaml(people, { sortById: true }), 'utf8'),
    writeFile(path.join(dataDir, 'places.yaml'), serializePlacesYaml(places, { sortById: true }), 'utf8'),
    writeFile(path.join(dataDir, 'events.yaml'), serializeEventsYaml([], { sortById: true }), 'utf8'),
    writeFile(path.join(dataDir, 'sources.yaml'), serializeSourcesYaml([], { sortById: true }), 'utf8'),
    writeFile(
      path.join(dataDir, 'kinship.yaml'),
      serializeKinshipYaml([], { sortDeterministic: true }),
      'utf8'
    ),
    writeFile(path.join(dataDir, 'media.yaml'), serializeMediaYaml([], { sortById: true }), 'utf8'),
    writeFile(path.join(dataDir, 'narratives.yaml'), serializeNarrativesYaml([], { sortById: true }), 'utf8'),
  ]);

  return siteDir;
}

describe('plugin auditChecks/verifyChecks and built-in pronunciation checks (#22)', () => {
  it('runs check-only site plugins discovered from extensions/ and kinloom.config.yaml in audit and verify', async () => {
    const siteDir = await createMinimalCheckArchive({
      plugins: ['./plugins/config-check.mjs'],
      pronunciations: {
        'Arthur Alder': {
          phonetic: 'AR-thur AWL-der',
          ipa: '/ˈɑːrθər ˈɔːldər/',
          source_label: 'Synthetic test fixture',
        },
        'Oak County': {
          phonetic: 'OHK KOWN-tee',
          ipa: '/oʊk ˈkaʊnti/',
          source_label: 'Synthetic test fixture',
        },
      },
    });

    const extDir = path.join(siteDir, 'extensions', 'ext-checks');
    const cfgDir = path.join(siteDir, 'plugins');
    const pkgDir = path.join(siteDir, 'research', 'people', 'per_arthur_alder');
    await Promise.all([
      mkdir(extDir, { recursive: true }),
      mkdir(cfgDir, { recursive: true }),
      mkdir(pkgDir, { recursive: true }),
    ]);

    await writeFile(
      path.join(extDir, 'cli.mjs'),
      `export default {
  id: 'ext-checks',
  name: 'Extension Quality Checks',
  auditChecks: [
    {
      id: 'require-research-note',
      name: 'Research Note Check',
      run({ patch }) {
        const missing = !patch.custom_note;
        return {
          errors: [],
          warnings: missing ? ['Missing custom_note in patch.json'] : [],
          strictFailures: missing ? ['Missing custom_note in patch.json'] : [],
          details: { hasNote: !missing },
        };
      },
    },
  ],
};
`,
      'utf8'
    );

    await writeFile(
      path.join(cfgDir, 'config-check.mjs'),
      `export const plugin = {
  id: 'config-checks',
  name: 'Config Verify Checks',
  verifyChecks: [
    {
      id: 'site-title-guard',
      name: 'Site Title Guard',
      run({ siteConfig }) {
        return {
          errors: siteConfig.site.title.includes('Alder') ? [] : ['Unexpected site title'],
          warnings: ['Advisory config verify notice'],
          strictWarnings: ['Strict config verify notice'],
        };
      },
    },
  ],
};
`,
      'utf8'
    );

    await writeFile(
      path.join(pkgDir, 'patch.json'),
      JSON.stringify({ person_id: 'per_arthur_alder' }, null, 2),
      'utf8'
    );

    const auditText = createCaptureIo();
    expect(await runCli(['audit', 'per_arthur_alder', '--repo', siteDir], { io: auditText.io })).toBe(
      EXIT_OK
    );
    expect(auditText.stdout.join('\n')).toContain('Plugin [ext-checks/require-research-note]');

    const auditStrict = createCaptureIo();
    expect(
      await runCli(['audit', 'per_arthur_alder', '--repo', siteDir, '--strict', '--json'], {
        io: auditStrict.io,
      })
    ).toBe(EXIT_ERROR);
    const auditStrictJson = JSON.parse(auditStrict.stdout.join('\n')) as {
      ok: boolean;
      strictOk: boolean;
      pluginChecks: Array<{ pluginId: string; id: string; ok: boolean; strictOk: boolean }>;
    };
    expect(auditStrictJson.ok).toBe(true);
    expect(auditStrictJson.strictOk).toBe(false);
    expect(auditStrictJson.pluginChecks).toEqual([
      expect.objectContaining({
        pluginId: 'ext-checks',
        id: 'require-research-note',
        ok: true,
        strictOk: false,
      }),
    ]);

    const verifyDefault = createCaptureIo();
    expect(await runCli(['verify', '--repo', siteDir, '--json'], { io: verifyDefault.io })).toBe(EXIT_OK);
    const verifyDefaultJson = JSON.parse(verifyDefault.stdout.join('\n')) as {
      ok: boolean;
      pluginChecks: Array<{ pluginId: string; id: string; warnings: string[] }>;
    };
    expect(verifyDefaultJson.ok).toBe(true);
    expect(verifyDefaultJson.pluginChecks).toEqual([
      expect.objectContaining({
        pluginId: 'config-checks',
        id: 'site-title-guard',
        warnings: ['Advisory config verify notice'],
      }),
    ]);

    const verifyStrict = createCaptureIo();
    expect(await runCli(['verify', '--repo', siteDir, '--strict'], { io: verifyStrict.io })).toBe(EXIT_ERROR);
    expect(verifyStrict.stdout.join('\n')).toContain('Plugin [config-checks/site-title-guard]');
    expect(verifyStrict.stdout.join('\n')).toContain('Strict config verify notice');
  });

  it('fails fast on duplicate plugin check IDs and isolates throwing plugin checks', async () => {
    const siteDir = await createMinimalCheckArchive({
      pronunciations: {
        'Arthur Alder': {
          phonetic: 'AR-thur AWL-der',
          ipa: '/ˈɑːrθər ˈɔːldər/',
          source_label: 'Synthetic test fixture',
        },
        'Oak County': {
          phonetic: 'OHK KOWN-tee',
          ipa: '/oʊk ˈkaʊnti/',
          source_label: 'Synthetic test fixture',
        },
      },
    });
    const pkgDir = path.join(siteDir, 'research', 'people', 'per_arthur_alder');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      path.join(pkgDir, 'patch.json'),
      JSON.stringify({ person_id: 'per_arthur_alder' }, null, 2),
      'utf8'
    );

    const pluginA: KinloomCliPlugin = {
      id: 'plugin-a',
      name: 'Plugin A',
      auditChecks: [
        {
          id: 'dup-check',
          name: 'First Dup Check',
          run: () => ({ errors: [], warnings: [] }),
        },
      ],
      verifyChecks: [
        {
          id: 'boom-verify',
          name: 'Exploding Verify Check',
          run: () => {
            throw new Error('simulated verify crash');
          },
        },
      ],
    };
    const pluginB: KinloomCliPlugin = {
      id: 'plugin-b',
      name: 'Plugin B',
      auditChecks: [
        {
          id: 'dup-check',
          name: 'Second Dup Check',
          run: () => ({ errors: ['should never run'], warnings: [] }),
        },
      ],
    };

    const auditCap = createCaptureIo();
    expect(
      await runCli(['audit', 'per_arthur_alder', '--repo', siteDir, '--json'], {
        io: auditCap.io,
        plugins: [pluginA, pluginB],
      })
    ).toBe(EXIT_USAGE);
    expect(auditCap.stdout).toEqual([]);
    expect(auditCap.stderr.join('\n')).toContain("duplicate audit check 'dup-check'");

    const verifyCap = createCaptureIo();
    expect(
      await runCli(['verify', '--repo', siteDir, '--json'], {
        io: verifyCap.io,
        plugins: [pluginA],
      })
    ).toBe(EXIT_ERROR);
    const verifyJson = JSON.parse(verifyCap.stdout.join('\n')) as {
      ok: boolean;
      errors: string[];
      pluginChecks: Array<{ id: string; ok: boolean; errors: string[] }>;
    };
    expect(verifyJson.ok).toBe(false);
    expect(verifyJson.pluginChecks[0]?.ok).toBe(false);
    expect(verifyJson.errors.some((e) => e.includes('simulated verify crash'))).toBe(true);
  });

  it('audits staged pronunciations (living leaks, missing/partial/unsourced, live deletion, and data/pronunciations.yaml)', async () => {
    const siteDir = await createMinimalCheckArchive({
      people: [
        {
          id: 'per_arthur_alder',
          slug: 'arthur-alder',
          full_name: 'Arthur Alder',
          given_name: 'Arthur',
          surname: 'Alder',
          alt_names: [],
          sex: 'M',
          is_living: false,
          lineage_group: 'ancestor',
          birth_edtf: '1858-04-12',
          death_edtf: '1932-09-18',
          portrait_url: null,
          pronunciation: {
            phonetic: 'AR-thur AWL-der',
            ipa: '/ˈɑːrθər ˈɔːldər/',
            source_label: 'Live archive lexicon',
          },
        },
        {
          id: 'per_living_kin',
          slug: 'living-kin',
          full_name: 'Jordan Alder',
          given_name: 'Jordan',
          surname: 'Alder',
          alt_names: [],
          sex: 'U',
          is_living: true,
          lineage_group: 'descendant',
          birth_edtf: '1992-05-01',
          death_edtf: '',
          portrait_url: null,
        },
      ],
    });

    const pkgDir = path.join(siteDir, 'research', 'people', 'per_arthur_alder');
    await mkdir(pkgDir, { recursive: true });

    // 1. Living leak in staged patch fails with hard error (even without --strict).
    await writeFile(
      path.join(pkgDir, 'patch.json'),
      JSON.stringify(
        {
          person_id: 'per_arthur_alder',
          people: [
            {
              id: 'per_living_kin',
              slug: 'living-kin',
              full_name: 'Jordan Alder',
              given_name: 'Jordan',
              surname: 'Alder',
              sex: 'U',
              is_living: true,
              lineage_group: 'descendant',
              birth_edtf: '1992-05-01',
              death_edtf: '',
              pronunciation: { phonetic: 'JOR-dun AWL-der' },
            },
          ],
        },
        null,
        2
      ),
      'utf8'
    );
    const leakCap = createCaptureIo();
    expect(await runCli(['audit', 'per_arthur_alder', '--repo', siteDir, '--json'], { io: leakCap.io })).toBe(
      EXIT_ERROR
    );
    const leakJson = JSON.parse(leakCap.stdout.join('\n')) as {
      ok: boolean;
      checks: { pronunciation: { ok: boolean; errors: string[] } };
    };
    expect(leakJson.ok).toBe(false);
    expect(leakJson.checks.pronunciation.ok).toBe(false);
    expect(leakJson.checks.pronunciation.errors.some((e) => e.includes('Living person'))).toBe(true);

    // 2. Deleting live pronunciation + unsourced staged place pronunciation fails --strict.
    await writeFile(
      path.join(pkgDir, 'patch.json'),
      JSON.stringify(
        {
          person_id: 'per_arthur_alder',
          person_updates: { pronunciation: null },
          places: [
            {
              id: 'plc_cedar_mill',
              slug: 'cedar-mill',
              name: 'Cedar Mill',
              full_name: 'Cedar Mill, Ohio, USA',
              place_type: 'town',
              parent_id: null,
              lat: 40.3,
              lng: -82.9,
              pronunciation: { phonetic: 'SEE-der MIL' },
            },
          ],
        },
        null,
        2
      ),
      'utf8'
    );
    const deleteCap = createCaptureIo();
    expect(
      await runCli(['audit', 'per_arthur_alder', '--repo', siteDir, '--strict', '--json'], {
        io: deleteCap.io,
      })
    ).toBe(EXIT_ERROR);
    const deleteJson = JSON.parse(deleteCap.stdout.join('\n')) as {
      ok: boolean;
      strictOk: boolean;
      checks: {
        pronunciation: {
          strictOk: boolean;
          warnings: string[];
          details?: { deletedLivePronunciation?: boolean; unsourcedEntries?: string[] };
        };
      };
    };
    expect(deleteJson.ok).toBe(true);
    expect(deleteJson.strictOk).toBe(false);
    expect(deleteJson.checks.pronunciation.details?.deletedLivePronunciation).toBe(true);
    expect(deleteJson.checks.pronunciation.details?.unsourcedEntries).toContain('place:plc_cedar_mill');

    // 3. Preserved live pronunciation + staged place resolved via data/pronunciations.yaml passes --strict.
    await writeFile(
      path.join(siteDir, 'data', 'pronunciations.yaml'),
      `"Cedar Mill":\n  phonetic: "SEE-der MIL"\n  ipa: "/ˈsiːdər mɪl/"\n  source_label: "Synthetic gazetteer"\n`,
      'utf8'
    );
    await writeFile(
      path.join(pkgDir, 'patch.json'),
      JSON.stringify(
        {
          person_id: 'per_arthur_alder',
          places: [
            {
              id: 'plc_cedar_mill',
              slug: 'cedar-mill',
              name: 'Cedar Mill',
              full_name: 'Cedar Mill, Ohio, USA',
              place_type: 'town',
              parent_id: null,
              lat: 40.3,
              lng: -82.9,
            },
          ],
        },
        null,
        2
      ),
      'utf8'
    );
    const cleanCap = createCaptureIo();
    expect(
      await runCli(['audit', 'per_arthur_alder', '--repo', siteDir, '--strict', '--json'], {
        io: cleanCap.io,
      })
    ).toBe(EXIT_OK);
    const cleanJson = JSON.parse(cleanCap.stdout.join('\n')) as {
      ok: boolean;
      strictOk: boolean;
      checks: { pronunciation: { ok: boolean; strictOk: boolean } };
    };
    expect(cleanJson.ok).toBe(true);
    expect(cleanJson.strictOk).toBe(true);
    expect(cleanJson.checks.pronunciation.ok).toBe(true);
    expect(cleanJson.checks.pronunciation.strictOk).toBe(true);
  });

  it('reports pronunciation coverage gaps as warnings in verify by default and fails under --strict-pronunciation or living leaks', async () => {
    const gapDir = await createMinimalCheckArchive();
    const defaultCap = createCaptureIo();
    expect(await runCli(['verify', '--repo', gapDir, '--json'], { io: defaultCap.io })).toBe(EXIT_OK);
    const defaultJson = JSON.parse(defaultCap.stdout.join('\n')) as {
      ok: boolean;
      checks: { pronunciation: { ok: boolean; warnings: string[] } };
    };
    expect(defaultJson.ok).toBe(true);
    expect(defaultJson.checks.pronunciation.ok).toBe(true);
    expect(defaultJson.checks.pronunciation.warnings.length).toBeGreaterThan(0);

    const strictCap = createCaptureIo();
    expect(
      await runCli(['verify', '--repo', gapDir, '--strict-pronunciation', '--json'], { io: strictCap.io })
    ).toBe(EXIT_ERROR);

    const leakDir = await createMinimalCheckArchive({
      people: [
        {
          id: 'per_living_leak',
          slug: 'living-leak',
          full_name: 'Morgan Alder',
          given_name: 'Morgan',
          surname: 'Alder',
          alt_names: [],
          sex: 'U',
          is_living: true,
          lineage_group: 'descendant',
          birth_edtf: '1990-01-01',
          death_edtf: '',
          portrait_url: null,
          pronunciation: { phonetic: 'MOR-gun AWL-der' },
        },
      ],
    });
    const leakCap = createCaptureIo();
    expect(await runCli(['verify', '--repo', leakDir, '--json'], { io: leakCap.io })).toBe(EXIT_ERROR);
    const leakJson = JSON.parse(leakCap.stdout.join('\n')) as {
      ok: boolean;
      checks: { pronunciation: { ok: boolean; errors: string[] } };
    };
    expect(leakJson.ok).toBe(false);
    expect(leakJson.checks.pronunciation.ok).toBe(false);
    expect(leakJson.checks.pronunciation.errors.length).toBeGreaterThan(0);
  });
});
