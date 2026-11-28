import fs from 'node:fs';
import path from 'node:path';

export function syncBuiltinModuleChangelogs(root, version) {
  const rel = 'packages/core/src/changelogs/builtinModuleChangelogs.ts';
  const full = path.join(root, rel);
  let source;
  try {
    source = fs.readFileSync(full, 'utf8');
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return;
    }
    throw err;
  }
  const today = new Date().toISOString().slice(0, 10);
  const entrySnippet = [
    '      {',
    `        version: '${version}',`,
    `        date: '${today}',`,
    `        summary: 'Kinloom v${version} release.',`,
    '        changes: [',
    '          {',
    "            category: 'changed',",
    `            text: 'Updated module for Kinloom v${version}.',`,
    '          },',
    '        ],',
    '      },',
  ].join('\n');

  const marker = /id: '@kinloom\/[a-z-]+',[\s\S]*?entries: \[\n/g;
  const updated = source.replaceAll(marker, (match, offset) => {
    const nextIdx = source.indexOf("id: '@kinloom/", offset + 10);
    const slice = nextIdx === -1 ? source.slice(offset) : source.slice(offset, nextIdx);
    if (slice.includes(`version: '${version}'`)) {
      return match;
    }
    return `${match}${entrySnippet}\n`;
  });
  const tmpDir = fs.mkdtempSync(path.join(path.dirname(full), '.kinloom-changelog-'));
  const tmpFile = path.join(tmpDir, 'builtinModuleChangelogs.ts');
  try {
    fs.writeFileSync(tmpFile, updated, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmpFile, full);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
