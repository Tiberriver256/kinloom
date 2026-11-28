import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const packages = [
  ['@kinloom/core', 'packages/core/package.json'],
  ['@kinloom/server', 'packages/server/package.json'],
  ['@kinloom/worker', 'packages/worker/package.json'],
  ['@kinloom/ui', 'packages/ui/package.json'],
  ['@kinloom/cli', 'packages/cli/package.json'],
  ['@kinloom/tokens', 'packages/tokens/package.json'],
];

const changelogFile = path.join(repoRoot, 'packages/core/src/changelogs/builtinModuleChangelogs.ts');
const source = fs.readFileSync(changelogFile, 'utf8');

let failed = 0;
for (const [pkgName, pkgJsonRel] of packages) {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, pkgJsonRel), 'utf8'));
  const version = pkgJson.version;
  const blockIdx = source.indexOf(`id: '${pkgName}'`);
  if (blockIdx === -1) {
    console.error(`FAIL: Missing changelog block for ${pkgName} in builtinModuleChangelogs.ts`);
    failed += 1;
    continue;
  }
  const nextBlockIdx = source.indexOf("id: '@kinloom/", blockIdx + 10);
  const slice = nextBlockIdx === -1 ? source.slice(blockIdx) : source.slice(blockIdx, nextBlockIdx);
  if (!slice.includes(`version: '${version}'`)) {
    console.error(
      `FAIL: ${pkgName} is at version ${version} in ${pkgJsonRel}, but builtinModuleChangelogs.ts has no entry for '${version}'.`
    );
    failed += 1;
  }
}

if (failed > 0) {
  process.exit(1);
}
console.log(
  `Changelog check passed (all ${packages.length} workspace modules match their current versions).`
);
