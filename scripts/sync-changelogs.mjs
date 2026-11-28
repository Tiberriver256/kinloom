import fs from 'node:fs';
import path from 'node:path';

export function syncBuiltinModuleChangelogs(root, version) {
  const rel = 'packages/core/src/changelogs/builtinModuleChangelogs.ts';
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    return;
  }
  const source = fs.readFileSync(full, 'utf8');
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
  fs.writeFileSync(full, updated);
}
