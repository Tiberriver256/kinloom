import fs from 'node:fs';
import path from 'node:path';

const tokensPath = path.resolve(import.meta.dirname, '../packages/tokens/tokens.json');
const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
const prim = tokens.color.primitive;
const sem = tokens.color.semantic;

function resolveColor(val) {
  const m = /^\{color\.primitive\.([^}]+)\}$/.exec(val);
  return m ? prim[m[1]].$value : val;
}

function luminance(hex) {
  const h = hex.replace('#', '');
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const pairs = [
  ['text-primary', 'surface-canvas', 7.0],
  ['text-primary', 'surface-card', 7.0],
  ['text-secondary', 'surface-canvas', 7.0],
  ['text-secondary', 'surface-card', 7.0],
  ['surface-header', 'surface-canvas', 7.0],
  ['text-inverse', 'surface-header', 7.0],
  ['accent-primary', 'surface-canvas', 4.5],
  ['accent-primary', 'surface-card', 7.0],
  ['accent-secondary', 'surface-canvas', 7.0],
  ['action-focus', 'surface-canvas', 7.0],
  ['status-conflict', 'surface-canvas', 7.0],
  ['diff-add-fg', 'diff-add-bg', 7.0],
  ['diff-del-fg', 'diff-del-bg', 7.0],
  ['badge-memory-fg', 'badge-memory-bg', 7.0],
  ['badge-cited-fg', 'badge-cited-bg', 7.0],
];

let failed = 0;
for (const [fgKey, bgKey, minRatio] of pairs) {
  const fg = resolveColor(sem[fgKey].$value);
  const bg = resolveColor(sem[bgKey].$value);
  const r = contrast(fg, bg);
  const ok = r >= minRatio;
  if (!ok) failed += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${fgKey} (${fg}) on ${bgKey} (${bg}): ${r.toFixed(2)}:1 (min ${minRatio}:1)`
  );
}

if (failed > 0) {
  process.exit(1);
}
console.log(`All ${pairs.length} Kinloom contrast checks passed.`);
