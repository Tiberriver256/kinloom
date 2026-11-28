import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TOKENS_PATH = path.resolve(import.meta.dirname, '../packages/tokens/tokens.json');
const CSS_PATH = path.resolve(import.meta.dirname, '../packages/tokens/kinloom.css');

export const CONTRAST_PAIRS = [
  ['text-primary', 'surface-canvas', 7.0],
  ['text-primary', 'surface-card', 7.0],
  ['text-primary', 'surface-linen', 7.0],
  ['text-secondary', 'surface-canvas', 7.0],
  ['text-secondary', 'surface-card', 7.0],
  ['surface-header', 'surface-canvas', 7.0],
  ['surface-header', 'surface-card', 7.0],
  ['text-inverse', 'surface-header', 7.0],
  ['text-inverse', 'accent-primary', 7.0],
  ['text-chrome-bar', 'surface-chrome-bar', 7.0],
  ['accent-primary', 'surface-canvas', 4.5],
  ['accent-primary', 'surface-card', 7.0],
  ['accent-secondary', 'surface-canvas', 7.0],
  ['accent-secondary', 'surface-card', 7.0],
  ['action-focus', 'surface-canvas', 7.0],
  ['action-focus', 'surface-card', 7.0],
  ['status-conflict', 'surface-canvas', 7.0],
  ['status-conflict', 'surface-card', 7.0],
  ['diff-add-fg', 'diff-add-bg', 7.0],
  ['diff-del-fg', 'diff-del-bg', 7.0],
  ['badge-memory-fg', 'badge-memory-bg', 7.0],
  ['badge-cited-fg', 'badge-cited-bg', 7.0],
  ['border-control', 'surface-canvas', 3.0],
  ['border-control', 'surface-card', 3.0],
];

export function resolveTokenColor(val, tokens) {
  const m = /^\{color\.(primitive|primitiveDark)\.([^}]+)\}$/.exec(val);
  if (!m) {
    return val;
  }
  const bucket = tokens.color[m[1]];
  const entry = bucket?.[m[2]];
  if (!entry) {
    throw new Error(`Unknown token reference: ${val}`);
  }
  return entry.$value;
}

export function luminance(hex) {
  const h = hex.replace('#', '');
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

function extractCssHexTokens(blockText) {
  const map = new Map();
  const declRe = /--([a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let match;
  while ((match = declRe.exec(blockText)) !== null) {
    const name = match[1];
    const value = match[2].trim();
    const hexMatch = /#[0-9a-fA-F]{6}\b/.exec(value);
    if (hexMatch) {
      map.set(name, hexMatch[0].toUpperCase());
    }
  }
  return map;
}

function extractRuleBlock(cssText, headerPattern) {
  const match = headerPattern.exec(cssText);
  if (!match) {
    return null;
  }
  const startBrace = cssText.indexOf('{', match.index);
  if (startBrace === -1) {
    return null;
  }
  let depth = 0;
  for (let i = startBrace; i < cssText.length; i += 1) {
    if (cssText[i] === '{') {
      depth += 1;
    } else if (cssText[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return cssText.slice(startBrace + 1, i);
      }
    }
  }
  return null;
}

export function runContrastAudit({ tokensPath = TOKENS_PATH, cssPath = CSS_PATH } = {}) {
  const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
  const cssText = fs.readFileSync(cssPath, 'utf8');

  const modes = [
    { mode: 'light', semantic: tokens.color.semantic },
    { mode: 'dark', semantic: tokens.color.semanticDark },
  ];

  const results = [];
  const cssMismatches = [];

  for (const { mode, semantic } of modes) {
    for (const [fgKey, bgKey, minRatio] of CONTRAST_PAIRS) {
      const fg = resolveTokenColor(semantic[fgKey].$value, tokens).toUpperCase();
      const bg = resolveTokenColor(semantic[bgKey].$value, tokens).toUpperCase();
      const ratio = contrast(fg, bg);
      const ok = ratio >= minRatio;
      results.push({ mode, fgKey, bgKey, fg, bg, ratio, minRatio, ok });
    }
  }

  const lightRootBlock = extractRuleBlock(cssText, /:root\s*\{/);
  const mediaDarkBlock = extractRuleBlock(cssText, /@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)\s*\{/);
  const dataDarkBlock = extractRuleBlock(cssText, /:root\[data-theme=['"]dark['"]\]\s*\{/);

  const cssBlocks = [
    { label: ':root (light)', semantic: tokens.color.semantic, block: lightRootBlock },
    {
      label: '@media (prefers-color-scheme: dark)',
      semantic: tokens.color.semanticDark,
      block: mediaDarkBlock,
    },
    { label: ":root[data-theme='dark']", semantic: tokens.color.semanticDark, block: dataDarkBlock },
  ];

  for (const { label, semantic, block } of cssBlocks) {
    if (!block) {
      cssMismatches.push(`Missing CSS block: ${label}`);
      continue;
    }
    const cssTokens = extractCssHexTokens(block);
    for (const [key, def] of Object.entries(semantic)) {
      const expected = resolveTokenColor(def.$value, tokens).toUpperCase();
      const actual = cssTokens.get(key);
      if (actual !== expected) {
        cssMismatches.push(`${label} --${key}: expected ${expected}, found ${actual ?? 'missing'}`);
      }
    }
  }

  const failedPairs = results.filter((item) => !item.ok);
  return {
    ok: failedPairs.length === 0 && cssMismatches.length === 0,
    results,
    failedPairs,
    cssMismatches,
  };
}

function main() {
  const audit = runContrastAudit();
  for (const item of audit.results) {
    console.log(
      `${item.ok ? 'PASS' : 'FAIL'} [${item.mode}] ${item.fgKey} (${item.fg}) on ${item.bgKey} (${item.bg}): ${item.ratio.toFixed(2)}:1 (min ${item.minRatio}:1)`
    );
  }
  for (const mismatch of audit.cssMismatches) {
    console.error(`FAIL [css-parity] ${mismatch}`);
  }
  if (!audit.ok) {
    process.exit(1);
  }
  console.log(
    `All ${audit.results.length} Kinloom contrast checks (24 light + 24 dark) and kinloom.css parity checks passed.`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
