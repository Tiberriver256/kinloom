import fs from 'node:fs';
import path from 'node:path';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const srcRoot = path.join(pkgRoot, 'src');
const distRoot = path.join(pkgRoot, 'dist');

function copyCssFiles(currentSrcDir, currentDistDir) {
  for (const entry of fs.readdirSync(currentSrcDir, { withFileTypes: true })) {
    const srcPath = path.join(currentSrcDir, entry.name);
    const distPath = path.join(currentDistDir, entry.name);
    if (entry.isDirectory()) {
      copyCssFiles(srcPath, distPath);
    } else if (entry.isFile() && entry.name.endsWith('.css')) {
      fs.mkdirSync(currentDistDir, { recursive: true });
      fs.copyFileSync(srcPath, distPath);
    }
  }
}

copyCssFiles(srcRoot, distRoot);
