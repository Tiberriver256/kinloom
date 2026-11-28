import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, '../../../..');
const TOKENS_CSS_PATH = join(REPO_ROOT, 'packages/tokens/kinloom.css');
const UI_SRC_DIR = join(REPO_ROOT, 'packages/ui/src');

function collectModuleCssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectModuleCssFiles(fullPath, out);
    } else if (entry.name.endsWith('.module.css')) {
      out.push(fullPath);
    }
  }
  return out.sort();
}

describe('semantic geometry tokens & CSS module hygiene (#100)', () => {
  it('defines canonical radius, control height, and border width tokens in packages/tokens/kinloom.css', () => {
    const css = readFileSync(TOKENS_CSS_PATH, 'utf8');
    const requiredTokens = [
      '--radius-control: 4px;',
      '--radius-pill: 9999px;',
      '--radius-sheet: 12px;',
      '--control-height-sm: 32px;',
      '--control-height-md: 36px;',
      '--control-height-touch: 44px;',
      '--border-width-thin: 1px;',
      '--border-width-emphasis: 2px;',
    ];

    for (const tokenDecl of requiredTokens) {
      expect(css, `Expected ${tokenDecl} in packages/tokens/kinloom.css`).toContain(tokenDecl);
    }
  });

  it('has zero hardcoded pixel border-radius literals in packages/ui/src/**/*.module.css', () => {
    const files = collectModuleCssFiles(UI_SRC_DIR);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        const match = line.match(/border-(?:(?:top|bottom)-(?:left|right)-)?radius\s*:\s*([^;]+);/);
        if (match?.[1] && /\b\d+(?:\.\d+)?px\b/.test(match[1])) {
          violations.push(`${relative(REPO_ROOT, file)}:${idx + 1}: ${line.trim()}`);
        }
      });
    }

    expect(violations, 'Hardcoded pixel border-radius literals found').toEqual([]);
  });

  it('has zero fractional border or outline widths in packages/ui/src/**/*.module.css', () => {
    const files = collectModuleCssFiles(UI_SRC_DIR);
    const violations: string[] = [];

    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (/(?:border|outline)[^:]*:\s*[^;]*\b\d+\.\d+px\b/.test(line)) {
          violations.push(`${relative(REPO_ROOT, file)}:${idx + 1}: ${line.trim()}`);
        }
      });
    }

    expect(violations, 'Fractional border/outline widths found').toEqual([]);
  });

  it('has zero raw hex color literals in packages/ui/src/**/*.module.css', () => {
    const files = collectModuleCssFiles(UI_SRC_DIR);
    const violations: string[] = [];

    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (/#[0-9a-fA-F]{3,8}\b/.test(line)) {
          violations.push(`${relative(REPO_ROOT, file)}:${idx + 1}: ${line.trim()}`);
        }
      });
    }

    expect(violations, 'Raw hex color literals found').toEqual([]);
  });

  it('unifies modal, floating-bar, and form control surfaces onto --radius-control', () => {
    const expectedControlRadiusFiles = [
      'packages/ui/src/styles/Controls.module.css',
      'packages/ui/src/styles/Overlays.module.css',
      'packages/ui/src/components/CanvasSurfacePrimitives.module.css',
      'packages/ui/src/components/GlobalSearchModal.module.css',
      'packages/ui/src/components/ExplorerTopBar.module.css',
      'packages/ui/src/components/tree/TreeToolbar.module.css',
      'packages/ui/src/components/tree/TreeKinshipLoom.module.css',
      'packages/ui/src/pages/IndexPage.module.css',
      'packages/ui/src/pages/PlacesIndexPage.module.css',
      'packages/ui/src/pages/MapPage.module.css',
      'packages/ui/src/pages/TreePage.module.css',
      'packages/ui/src/pages/KinshipPage.module.css',
    ];

    for (const relPath of expectedControlRadiusFiles) {
      const css = readFileSync(join(REPO_ROOT, relPath), 'utf8');
      expect(css, `Expected ${relPath} to consume var(--radius-control)`).toContain('var(--radius-control)');
    }
  });
});
