import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const blocklistIdx = args.indexOf('--blocklist');
const extraTerms = [];

if (blocklistIdx !== -1 && args[blocklistIdx + 1]) {
  const raw = fs.readFileSync(args[blocklistIdx + 1], 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith('#')) extraTerms.push(t);
  }
}

const forbiddenFilePatterns = [/\.ged$/i, /ancestry-export/i];
const forbiddenTextPatterns = [
  /ancestry-export/i,
  /[a-z0-9._%+-]+@gmail\.com/i,
  ...extraTerms.map((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')),
];

const skipDirs = new Set(['.git', 'node_modules', 'dist', '.venv']);
const findings = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    for (const pat of forbiddenFilePatterns) {
      if (pat.test(rel)) findings.push(`Forbidden file path: ${rel}`);
    }
    if (rel === 'scripts/check-public-leaks.mjs') continue;
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) continue;
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const pat of forbiddenTextPatterns) {
        if (pat.test(line)) {
          findings.push(`${rel}:${idx + 1} matched ${pat}`);
        }
      }
    });
  }
}

walk(root);

if (findings.length > 0) {
  console.error('Public leak check FAILED:');
  for (const f of findings) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`Public leak check passed (scanned ${root}, ${extraTerms.length} external blocklist terms).`);
