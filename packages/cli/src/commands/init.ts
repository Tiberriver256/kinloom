import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseKinloomConfig, serializeKinloomConfigYaml } from '@kinloom/core';
import { CliValidationError } from '../errors.js';
import { ARCHIVE_YAML_FILE_NAMES } from './dataFiles.js';

export interface InitCommandOptions {
  targetDir: string;
  family: string;
  title: string;
  accent?: string;
  force?: boolean;
}

export interface InitCommandResult {
  targetDir: string;
  created: string[];
  skipped: string[];
}

function slugifyIdentifier(raw: string): string {
  const slug = raw
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return slug || 'primary';
}

function toGedcomSourceName(family: string): string {
  const upper = family
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036F]/g, '')
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');
  return upper ? `${upper}_ARCHIVE` : 'KINLOOM_ARCHIVE';
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

const BACKUP_WORKFLOW_YAML = `name: Nightly Archive Backup

on:
  workflow_dispatch:
  schedule:
    - cron: "0 6 * * *"

permissions:
  contents: write

jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - name: Export deterministic YAML snapshot
        env:
          KINLOOM_TOKEN: \${{ secrets.KINLOOM_BACKUP_TOKEN }}
        run: |
          npx -y @kinloom/cli@latest export-yaml \\
            --site "\${{ vars.KINLOOM_SITE_URL }}" \\
            --out data \\
            --state-file data/.last-backup-revision
      - name: Commit backup when revision advanced
        run: |
          if [ -z "$(git status --porcelain data)" ]; then
            echo "No archive changes since last backup."
            exit 0
          fi
          REV="$(cat data/.last-backup-revision)"
          git config user.name "kinloom-backup[bot]"
          git config user.email "kinloom-backup[bot]@users.noreply.github.com"
          git add data
          git commit -m "chore(backup): sync archive snapshot r\${REV}"
          git push
`;

const RECONCILE_WORKFLOW_YAML = `name: Reconcile Archive Bundle

on:
  workflow_dispatch:
  schedule:
    - cron: "0 7 * * 0"

jobs:
  reconcile:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - name: Verify cached bundle matches full archive compilation
        env:
          KINLOOM_TOKEN: \${{ secrets.KINLOOM_BACKUP_TOKEN }}
        run: |
          npx -y @kinloom/cli@latest reconcile \\
            --site "\${{ vars.KINLOOM_SITE_URL }}" \\
            --config kinloom.config.yaml
`;

const EXTENSIONS_README_MD = `# Private Archive Extensions

Place family-specific UI or server plugins in this directory so custom storytelling
modules stay isolated from public \`@kinloom/ui\` and \`@kinloom/server\`.

## Registering a \`KinloomUiPlugin\` (Example: Video Story)

\`\`\`tsx
import type { KinloomUiPlugin } from '@kinloom/ui';

export const videoStoryPlugin: KinloomUiPlugin = {
  id: 'family-video-stories',
  name: 'Family Video Stories',
  routes: [
    {
      path: '/stories/homestead-film',
      navLabel: 'Stories',
      component: () => (
        <section>
          <h1>Homestead Oral History</h1>
          <video controls preload="metadata" src="/media/example-story.mp4" />
        </section>
      ),
    },
  ],
  slots: {
    personDetail: ({ person }) =>
      person.id === 'per_example_ancestor' ? (
        <a href="/stories/homestead-film">Watch oral-history video story</a>
      ) : null,
  },
  mediaRenderers: [
    {
      match: (media) => media.kind === 'video_story',
      render: ({ media, src }) => (
        <figure>
          <video controls preload="metadata" poster={media.poster_url ?? undefined} src={src} />
          <figcaption>{media.caption}</figcaption>
        </figure>
      ),
    },
  ],
};
\`\`\`

Pass \`plugins={[videoStoryPlugin]}\` into \`<KinloomApp />\` in your private site entrypoint.

## Vite Configuration (Single React Instance)

When building a private site app with Vite, include \`resolve.dedupe\` in \`vite.config.ts\` so \`@kinloom/ui\` and your site share one React and Router instance:

\`\`\`ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom', 'react-router-dom'],
  },
});
\`\`\`
`;

const GITIGNORE_CONTENT = `node_modules/
dist/
.wrangler/
.env
.env.*
*.local
raw-gedcom/
`;

export async function runInitCommand(options: InitCommandOptions): Promise<InitCommandResult> {
  const targetDir = options.targetDir.trim();
  const family = options.family.trim();
  const title = options.title.trim();
  const accent = options.accent?.trim() || '#7A4612';

  if (!targetDir) {
    throw new CliValidationError('Target directory is required for `kinloom init`.');
  }
  if (!family) {
    throw new CliValidationError('`--family` must be a non-empty family name.');
  }
  if (!title) {
    throw new CliValidationError('`--title` must be a non-empty site title.');
  }

  const branchId = slugifyIdentifier(family);
  let config;
  try {
    config = parseKinloomConfig({
      schemaVersion: 1,
      site: {
        title,
        familyName: family,
        gedcomSourceName: toGedcomSourceName(family),
        description: `Archival family history explorer for the ${family} lineage.`,
      },
      theme: {
        accent,
      },
      defaultBranchId: branchId,
      branches: [
        {
          id: branchId,
          label: `${family} Line`,
          surnames: [family],
          lineageGroups: ['pivot_ancestor', 'ancestor', 'descendant'],
          supportsDirectMode: true,
        },
      ],
      lineageSections: [
        {
          id: 'direct-ancestors',
          title: 'Direct Ancestors',
          lineageGroups: ['pivot_ancestor', 'ancestor'],
          branchId,
        },
        {
          id: 'descendants',
          title: 'Descendants',
          lineageGroups: ['descendant'],
          branchId,
        },
      ],
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(`Invalid kinloom.config.yaml options: ${message}`);
  }

  const resolvedDir = path.resolve(targetDir);
  const filesToWrite: Array<[string, string]> = [
    ['kinloom.config.yaml', serializeKinloomConfigYaml(config)],
    ...ARCHIVE_YAML_FILE_NAMES.map(
      (name): [string, string] => [path.join('data', name), '[]\n']
    ),
    [path.join('.github', 'workflows', 'backup.yml'), BACKUP_WORKFLOW_YAML],
    [path.join('.github', 'workflows', 'reconcile.yml'), RECONCILE_WORKFLOW_YAML],
    [path.join('extensions', 'README.md'), EXTENSIONS_README_MD],
    ['.gitignore', GITIGNORE_CONTENT],
  ];

  const created: string[] = [];
  const skipped: string[] = [];

  for (const [relativePath, content] of filesToWrite) {
    const fullPath = path.join(resolvedDir, relativePath);
    if (!options.force && (await fileExists(fullPath))) {
      skipped.push(relativePath);
      continue;
    }
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, 'utf8');
    created.push(relativePath);
  }

  return {
    targetDir: resolvedDir,
    created,
    skipped,
  };
}
