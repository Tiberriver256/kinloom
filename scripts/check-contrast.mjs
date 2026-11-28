import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TOKENS_PATH = path.resolve(import.meta.dirname, '../packages/tokens/tokens.json');
const CSS_PATH = path.resolve(import.meta.dirname, '../packages/tokens/kinloom.css');

// Published APCA 0.0.98G-4g-base-W3 constants (synced with packages/cli/src/commands/ops/design-audit/apca.ts)
const APCA_MAIN_TRC = 2.4;
const APCA_S_R_CO = 0.2126729;
const APCA_S_G_CO = 0.7151522;
const APCA_S_B_CO = 0.072175;
const APCA_NORM_BG = 0.56;
const APCA_NORM_TXT = 0.57;
const APCA_REV_TXT = 0.62;
const APCA_REV_BG = 0.65;
const APCA_BLK_THRS = 0.022;
const APCA_BLK_CLMP = 1.414;
const APCA_SCALE_BOW = 1.14;
const APCA_SCALE_WOB = 1.14;
const APCA_LO_BOW_OFFSET = 0.027;
const APCA_LO_WOB_OFFSET = 0.027;
const APCA_LO_CLIP = 0.1;
const APCA_DELTA_Y_MIN = 0.0005;

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
  ['text-on-action-primary', 'surface-action-primary', 7.0],
  ['text-on-action-primary', 'surface-action-primary-hover', 7.0],
  ['text-on-action-primary-muted', 'surface-action-primary', 7.0],
  ['accent-primary', 'surface-canvas', 4.5],
  ['accent-primary', 'surface-card', 7.0],
  ['accent-primary', 'surface-subtle', 7.0],
  ['accent-primary', 'surface-linen', 7.0],
  ['accent-primary', 'surface-muted', 7.0],
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
  ['jump-active-fg', 'surface-canvas', 7.0],
  ['jump-active-fg', 'surface-subtle', 7.0],
  ['text-primary', 'surface-subtle', 7.0],
  ['text-secondary', 'surface-subtle', 7.0],
];

/**
 * APCA 0.0.98G-4g-base-W3 perceptual contrast assertions (#107).
 * Each entry enforces `minLc <= |Lc| <= maxLc` (when maxLc is specified).
 */
export const APCA_CONTRAST_CHECKS = [
  // Accent ink on primary and elevated tinted surfaces (>= Lc 75 in both modes)
  { mode: 'both', fgKey: 'accent-primary', bgKey: 'surface-canvas', minLc: 75 },
  { mode: 'both', fgKey: 'accent-primary', bgKey: 'surface-card', minLc: 75 },
  { mode: 'both', fgKey: 'accent-primary', bgKey: 'surface-subtle', minLc: 75 },
  { mode: 'both', fgKey: 'accent-primary', bgKey: 'surface-linen', minLc: 75 },
  { mode: 'both', fgKey: 'accent-primary', bgKey: 'surface-muted', minLc: 75 },
  // Primary action & selected card surfaces (>= Lc 75 in both modes)
  { mode: 'both', fgKey: 'text-on-action-primary', bgKey: 'surface-action-primary', minLc: 75 },
  { mode: 'both', fgKey: 'text-on-action-primary', bgKey: 'surface-action-primary-hover', minLc: 75 },
  { mode: 'both', fgKey: 'text-on-action-primary-muted', bgKey: 'surface-action-primary', minLc: 75 },
  // Banner separator & header ink on card (>= Lc 75 in light)
  { mode: 'light', fgKey: 'surface-header', bgKey: 'surface-card', minLc: 75 },
  // Dark-mode display heading halation ceiling (Lc 82..88, <= Lc 90)
  { mode: 'dark', fgKey: 'surface-header', bgKey: 'surface-canvas', minLc: 82, maxLc: 88 },
  { mode: 'dark', fgKey: 'surface-header', bgKey: 'surface-card', minLc: 82, maxLc: 88 },
  // Nocturnal secondary metadata ink (>= Lc 75 on canvas & card)
  { mode: 'dark', fgKey: 'text-secondary', bgKey: 'surface-canvas', minLc: 75 },
  { mode: 'dark', fgKey: 'text-secondary', bgKey: 'surface-card', minLc: 75 },
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

function apcaLuminance(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return (
    APCA_S_R_CO * r ** APCA_MAIN_TRC + APCA_S_G_CO * g ** APCA_MAIN_TRC + APCA_S_B_CO * b ** APCA_MAIN_TRC
  );
}

/**
 * Computes signed APCA Lightness Contrast (Lc) using 0.0.98G-4g-base-W3.
 */
export function calcApcaLc(fgHex, bgHex) {
  let txtY = apcaLuminance(fgHex);
  let bgY = apcaLuminance(bgHex);

  if (txtY < APCA_BLK_THRS) {
    txtY += (APCA_BLK_THRS - txtY) ** APCA_BLK_CLMP;
  }
  if (bgY < APCA_BLK_THRS) {
    bgY += (APCA_BLK_THRS - bgY) ** APCA_BLK_CLMP;
  }

  if (Math.abs(bgY - txtY) < APCA_DELTA_Y_MIN) {
    return 0;
  }

  let sapc = 0;
  let outputContrast = 0;
  if (bgY > txtY) {
    sapc = (bgY ** APCA_NORM_BG - txtY ** APCA_NORM_TXT) * APCA_SCALE_BOW;
    outputContrast = sapc < APCA_LO_CLIP ? 0 : sapc - APCA_LO_BOW_OFFSET;
  } else {
    sapc = (bgY ** APCA_REV_BG - txtY ** APCA_REV_TXT) * APCA_SCALE_WOB;
    outputContrast = sapc > -APCA_LO_CLIP ? 0 : sapc + APCA_LO_WOB_OFFSET;
  }

  return Number((outputContrast * 100).toFixed(2));
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
  const apcaResults = [];
  const cssMismatches = [];

  for (const { mode, semantic } of modes) {
    for (const [fgKey, bgKey, minRatio] of CONTRAST_PAIRS) {
      const fg = resolveTokenColor(semantic[fgKey].$value, tokens).toUpperCase();
      const bg = resolveTokenColor(semantic[bgKey].$value, tokens).toUpperCase();
      const ratio = contrast(fg, bg);
      const ok = ratio >= minRatio;
      results.push({ mode, fgKey, bgKey, fg, bg, ratio, minRatio, ok });
    }

    for (const check of APCA_CONTRAST_CHECKS) {
      if (check.mode !== 'both' && check.mode !== mode) {
        continue;
      }
      const fg = resolveTokenColor(semantic[check.fgKey].$value, tokens).toUpperCase();
      const bg = resolveTokenColor(semantic[check.bgKey].$value, tokens).toUpperCase();
      const lc = calcApcaLc(fg, bg);
      const absLc = Math.abs(lc);
      const ok = absLc >= check.minLc && (check.maxLc === undefined || absLc <= check.maxLc);
      apcaResults.push({
        mode,
        fgKey: check.fgKey,
        bgKey: check.bgKey,
        fg,
        bg,
        lc,
        absLc,
        minLc: check.minLc,
        maxLc: check.maxLc,
        ok,
      });
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
  const failedApca = apcaResults.filter((item) => !item.ok);
  return {
    ok: failedPairs.length === 0 && failedApca.length === 0 && cssMismatches.length === 0,
    results,
    apcaResults,
    failedPairs,
    failedApca,
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
  for (const item of audit.apcaResults) {
    const bounds = item.maxLc !== undefined ? `Lc ${item.minLc}..${item.maxLc}` : `min Lc ${item.minLc}`;
    console.log(
      `${item.ok ? 'PASS' : 'FAIL'} [apca-${item.mode}] ${item.fgKey} (${item.fg}) on ${item.bgKey} (${item.bg}): |Lc| ${item.absLc.toFixed(2)} (${bounds})`
    );
  }
  for (const mismatch of audit.cssMismatches) {
    console.error(`FAIL [css-parity] ${mismatch}`);
  }
  if (!audit.ok) {
    process.exit(1);
  }
  console.log(
    `All ${audit.results.length} Kinloom WCAG contrast checks (${CONTRAST_PAIRS.length} light + ${CONTRAST_PAIRS.length} dark), ${audit.apcaResults.length} APCA checks, and kinloom.css parity checks passed.`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
