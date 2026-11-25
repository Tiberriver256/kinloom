import fs from 'node:fs';
import path from 'node:path';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const srcCss = path.join(pkgRoot, 'src', 'styles', 'archival.css');
const destDir = path.join(pkgRoot, 'dist', 'styles');
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(srcCss, path.join(destDir, 'archival.css'));
