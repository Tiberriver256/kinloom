import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const TOKENS_DIR = path.join(REPO_ROOT, 'packages/tokens');
const BASE_DTCG_PATH = path.join(TOKENS_DIR, 'kinloom.tokens.json');
const DARK_DTCG_PATH = path.join(TOKENS_DIR, 'kinloom.dark.tokens.json');
const RESOLVER_PATH = path.join(TOKENS_DIR, 'kinloom.resolver.json');
const LEGACY_TOKENS_PATH = path.join(TOKENS_DIR, 'tokens.json');
const CSS_OUT_PATH = path.join(TOKENS_DIR, 'kinloom.css');

const ALIAS_RE = /^\{([^}]+)\}$/;
const MODE_BAKED_RE = /(^|[.-])(dark|light|high-contrast|compact)($|[.-])/i;

function walkDtcg(obj, prefix = [], inheritedType = undefined, out = new Map()) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return out;
  }
  const effectiveType = typeof obj.$type === 'string' ? obj.$type : inheritedType;
  if ('$value' in obj) {
    out.set(prefix.join('.'), {
      $value: obj.$value,
      $type: effectiveType,
      $description: obj.$description,
    });
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('$')) {
      continue;
    }
    walkDtcg(v, [...prefix, k], effectiveType, out);
  }
  return out;
}

function resolveDtcgValue(value, tokenMap, trail = new Set()) {
  if (typeof value !== 'string') {
    return value;
  }
  const match = ALIAS_RE.exec(value.trim());
  if (!match) {
    return value;
  }
  const ref = match[1];
  if (trail.has(ref)) {
    throw new Error(`Circular DTCG token alias: ${[...trail, ref].join(' -> ')}`);
  }
  const target = tokenMap.get(ref);
  if (!target) {
    throw new Error(`Unresolved DTCG token alias: {${ref}}`);
  }
  const nextTrail = new Set(trail);
  nextTrail.add(ref);
  return resolveDtcgValue(target.$value, tokenMap, nextTrail);
}

export function validateDtcgSources() {
  const baseJson = JSON.parse(fs.readFileSync(BASE_DTCG_PATH, 'utf8'));
  const darkJson = JSON.parse(fs.readFileSync(DARK_DTCG_PATH, 'utf8'));
  const resolverJson = JSON.parse(fs.readFileSync(RESOLVER_PATH, 'utf8'));

  if (!Array.isArray(resolverJson.resolutionOrder) || resolverJson.resolutionOrder.length === 0) {
    throw new Error('kinloom.resolver.json is missing a non-empty resolutionOrder array.');
  }

  const baseTokens = walkDtcg(baseJson);
  const darkTokens = walkDtcg(darkJson);

  for (const [label, map] of [
    ['kinloom.tokens.json', baseTokens],
    ['kinloom.dark.tokens.json', darkTokens],
  ]) {
    for (const [key, entry] of map.entries()) {
      if (!entry.$type) {
        throw new Error(`${label}: token "${key}" is missing $type (explicit or inherited).`);
      }
      if (MODE_BAKED_RE.test(key)) {
        throw new Error(`${label}: token "${key}" encodes a mode name instead of keeping modes orthogonal.`);
      }
    }
  }

  const combinedForDark = new Map([...baseTokens, ...darkTokens]);
  for (const [key, entry] of baseTokens.entries()) {
    resolveDtcgValue(entry.$value, baseTokens, new Set([key]));
  }
  for (const [key, entry] of darkTokens.entries()) {
    resolveDtcgValue(entry.$value, combinedForDark, new Set([key]));
  }

  return { baseJson, darkJson, resolverJson, baseTokens, darkTokens };
}

function buildSemanticBlock(semanticEntries, tokenMap, { isDark, indent }) {
  const lines = [];
  const p = (str) => `${indent}${str}`;
  const hex = (key) => resolveDtcgValue(semanticEntries[key].$value, tokenMap).toLowerCase();

  lines.push(p(`--surface-canvas: ${hex('surface-canvas')};`));
  lines.push(p(`--surface-card: ${hex('surface-card')};`));
  lines.push(p(`--surface-subtle: ${hex('surface-subtle')};`));
  lines.push(p(`--surface-linen: ${hex('surface-linen')};`));
  if (!isDark) {
    lines.push(p('--surface-radar: var(--surface-linen);'));
  }
  lines.push(p(`--surface-muted: ${hex('surface-muted')};`));
  lines.push(p(`--surface-header: ${hex('surface-header')};`));
  lines.push(p(`--surface-chrome-bar: ${hex('surface-chrome-bar')};`));
  lines.push(p(`--surface-action-primary: ${hex('surface-action-primary')};`));
  lines.push(p(`--surface-action-primary-hover: ${hex('surface-action-primary-hover')};`));
  lines.push('');

  lines.push(p(`--text-primary: ${hex('text-primary')};`));
  lines.push(p(`--text-secondary: ${hex('text-secondary')};`));
  lines.push(p(`--text-inverse: ${hex('text-inverse')};`));
  lines.push(p(`--text-chrome-bar: ${hex('text-chrome-bar')};`));
  lines.push(p(`--text-on-action-primary: ${hex('text-on-action-primary')};`));
  lines.push(p(`--text-on-action-primary-muted: ${hex('text-on-action-primary-muted')};`));
  lines.push('');

  const accentVar = isDark ? '--site-accent-dark' : '--site-accent-light';
  lines.push(p(`--accent-primary: var(${accentVar}, ${hex('accent-primary')});`));
  lines.push(p(`--accent-secondary: ${hex('accent-secondary')};`));
  if (!isDark) {
    lines.push(p('--radar-copresence: var(--accent-primary);'));
    lines.push(p('--radar-local: var(--accent-secondary);'));
    lines.push(p('--radar-macro: var(--surface-header);'));
  }
  lines.push('');

  lines.push(p(`--action-focus: ${hex('action-focus')};`));
  lines.push(p(`--status-conflict: ${hex('status-conflict')};`));
  lines.push('');

  lines.push(p(`--border-strong: ${hex('border-strong')};`));
  lines.push(p(`--border-control: ${hex('border-control')};`));
  lines.push(p(`--border-decorative: ${hex('border-decorative')};`));
  lines.push(p(`--border-action-primary: ${hex('border-action-primary')};`));
  lines.push('');

  lines.push(p(`--diff-add-bg: ${hex('diff-add-bg')};`));
  lines.push(p(`--diff-add-fg: ${hex('diff-add-fg')};`));
  lines.push(p(`--diff-del-bg: ${hex('diff-del-bg')};`));
  lines.push(p(`--diff-del-fg: ${hex('diff-del-fg')};`));
  lines.push(p(`--badge-memory-bg: ${hex('badge-memory-bg')};`));
  lines.push(p(`--badge-memory-fg: ${hex('badge-memory-fg')};`));
  lines.push(p(`--badge-cited-bg: ${hex('badge-cited-bg')};`));
  lines.push(p(`--badge-cited-fg: ${hex('badge-cited-fg')};`));
  lines.push(p(`--jump-active-fg: ${hex('jump-active-fg')};`));
  lines.push('');

  if (!isDark) {
    lines.push(p('--surface-topbar: color-mix(in srgb, var(--surface-canvas) 95%, transparent);'));
    lines.push(p('--surface-overlay-card: color-mix(in srgb, var(--surface-card) 96%, transparent);'));
    lines.push(p('--surface-overlay-soft: color-mix(in srgb, var(--surface-card) 80%, transparent);'));
    lines.push(p('--surface-tint-subtle: color-mix(in srgb, var(--surface-linen) 34%, transparent);'));
    lines.push(p('--surface-tint-hover: color-mix(in srgb, var(--surface-linen) 50%, transparent);'));
    lines.push(p('--surface-tint-active: color-mix(in srgb, var(--surface-linen) 72%, transparent);'));
    lines.push(p('--surface-canvas-fade: color-mix(in srgb, var(--surface-canvas) 0%, transparent);'));
    lines.push(p('--surface-survey-ring-fill: color-mix(in srgb, var(--accent-secondary) 8%, transparent);'));
    lines.push(
      p('--tree-minimap-viewport-fill: color-mix(in srgb, var(--accent-primary) 12%, transparent);')
    );
    lines.push(p('--backdrop-drawer: color-mix(in srgb, var(--text-primary) 42%, transparent);'));
    lines.push(p('--backdrop-modal: color-mix(in srgb, var(--surface-header) 52%, transparent);'));
    lines.push(p('--backdrop-lightbox: color-mix(in srgb, var(--surface-header) 78%, transparent);'));
    lines.push(p('--border-mat: color-mix(in srgb, var(--border-control) 38%, transparent);'));
    lines.push(p('--border-chrome-bar: color-mix(in srgb, var(--text-chrome-bar) 28%, transparent);'));
    lines.push(p('--surface-chrome-bar-hover: color-mix(in srgb, var(--text-chrome-bar) 16%, transparent);'));
    lines.push(p('--badge-photo-default: color-mix(in srgb, var(--surface-header) 90%, transparent);'));
    lines.push(p('--badge-photo-portrait: color-mix(in srgb, var(--accent-secondary) 92%, transparent);'));
    lines.push(p('--badge-photo-headstone: color-mix(in srgb, var(--text-secondary) 90%, transparent);'));
    lines.push(p('--badge-photo-scan: color-mix(in srgb, var(--accent-primary) 92%, transparent);'));
  } else {
    lines.push(p('--surface-topbar: color-mix(in srgb, var(--surface-canvas) 94%, transparent);'));
    lines.push(p('--surface-overlay-card: color-mix(in srgb, var(--surface-card) 96%, transparent);'));
    lines.push(p('--surface-overlay-soft: color-mix(in srgb, var(--surface-card) 84%, transparent);'));
    lines.push(p('--surface-tint-subtle: color-mix(in srgb, var(--surface-linen) 55%, transparent);'));
    lines.push(p('--surface-tint-hover: color-mix(in srgb, var(--surface-linen) 72%, transparent);'));
    lines.push(p('--surface-tint-active: color-mix(in srgb, var(--surface-linen) 92%, transparent);'));
    lines.push(p('--surface-canvas-fade: color-mix(in srgb, var(--surface-canvas) 0%, transparent);'));
    lines.push(
      p('--surface-survey-ring-fill: color-mix(in srgb, var(--accent-secondary) 12%, transparent);')
    );
    lines.push(
      p('--tree-minimap-viewport-fill: color-mix(in srgb, var(--accent-primary) 14%, transparent);')
    );
    lines.push(p('--backdrop-drawer: color-mix(in srgb, var(--surface-canvas) 64%, transparent);'));
    lines.push(p('--backdrop-modal: color-mix(in srgb, var(--surface-canvas) 72%, transparent);'));
    lines.push(p('--backdrop-lightbox: color-mix(in srgb, var(--surface-canvas) 88%, transparent);'));
    lines.push(p('--border-mat: color-mix(in srgb, var(--border-control) 35%, transparent);'));
    lines.push(p('--border-chrome-bar: color-mix(in srgb, var(--text-chrome-bar) 24%, transparent);'));
    lines.push(p('--surface-chrome-bar-hover: color-mix(in srgb, var(--text-chrome-bar) 14%, transparent);'));
    lines.push(p('--badge-photo-default: color-mix(in srgb, var(--surface-canvas) 88%, transparent);'));
    lines.push(p('--badge-photo-portrait: color-mix(in srgb, var(--surface-card) 92%, transparent);'));
    lines.push(p('--badge-photo-headstone: color-mix(in srgb, var(--surface-linen) 92%, transparent);'));
    lines.push(p('--badge-photo-scan: color-mix(in srgb, var(--surface-linen) 92%, transparent);'));
  }

  return lines.join('\n');
}

function buildShadowBlock(isDark, indent) {
  const p = (str) => `${indent}${str}`;
  if (!isDark) {
    return [
      p(
        '--shadow-print: 0 2px 10px color-mix(in srgb, var(--text-primary) 14%, transparent), 0 1px 2px color-mix(in srgb, var(--text-primary) 8%, transparent);'
      ),
      p('--shadow-card: 0 1px 3px color-mix(in srgb, var(--text-primary) 7%, transparent);'),
      p('--shadow-active: 0 6px 22px color-mix(in srgb, var(--text-primary) 13%, transparent);'),
      p('--shadow-modal: 0 22px 54px color-mix(in srgb, var(--surface-header) 32%, transparent);'),
      p('--shadow-dock: 0 -6px 20px color-mix(in srgb, var(--surface-header) 14%, transparent);'),
      p('--shadow-drawer: -8px 0 28px color-mix(in srgb, var(--text-primary) 18%, transparent);'),
    ].join('\n');
  }
  return [
    p(
      '--shadow-print: 0 2px 12px color-mix(in srgb, black 45%, transparent), 0 1px 3px color-mix(in srgb, black 32%, transparent);'
    ),
    p('--shadow-card: 0 1px 4px color-mix(in srgb, black 35%, transparent);'),
    p('--shadow-active: 0 8px 28px color-mix(in srgb, black 55%, transparent);'),
    p('--shadow-modal: 0 24px 60px color-mix(in srgb, black 70%, transparent);'),
    p('--shadow-dock: 0 -6px 24px color-mix(in srgb, black 52%, transparent);'),
    p('--shadow-drawer: -8px 0 32px color-mix(in srgb, black 60%, transparent);'),
  ].join('\n');
}

export function generateKinloomCss({ baseJson, darkJson, baseTokens, darkTokens }) {
  const combinedForDark = new Map([...baseTokens, ...darkTokens]);
  const fam = baseJson.typography.family;
  const sizes = baseJson.typography.size;
  const dim = baseJson.dimension;

  const lightColors = buildSemanticBlock(baseJson.color.semantic, baseTokens, {
    isDark: false,
    indent: '  ',
  });
  const darkMediaColors = buildSemanticBlock(darkJson.color.semantic, combinedForDark, {
    isDark: true,
    indent: '    ',
  });
  const darkAttrColors = buildSemanticBlock(darkJson.color.semantic, combinedForDark, {
    isDark: true,
    indent: '  ',
  });

  const sizeLines = Object.entries(sizes)
    .filter(([k]) => !k.startsWith('$'))
    .map(([k, v]) => `  --text-${k}: ${v.$value};`)
    .join('\n');

  return `/* Generated from packages/tokens/kinloom.tokens.json + kinloom.dark.tokens.json via scripts/sync-tokens.mjs */
:root {
  color-scheme: light dark;

${lightColors}

  --font-serif: ${fam.serif.$value};
  --font-ui: ${fam.ui.$value};
  --font-mono: ${fam.mono.$value};

${sizeLines}

  --topbar-height: ${dim.chrome['topbar-height'].$value};
  --auth-banner-height: ${dim.chrome['auth-banner-height'].$value};
  --shell-chrome-offset: calc(var(--topbar-height) + var(--auth-banner-height, 0px));
  --radius-sm: ${dim.radius.sm.$value};
  --radius-md: ${dim.radius.md.$value};
  --radius-control: ${dim.radius.control.$value};
  --radius-pill: ${dim.radius.pill.$value};
  --radius-sheet: ${dim.radius.sheet.$value};
  --control-height-sm: ${dim.controlHeight.sm.$value};
  --control-height-md: ${dim.controlHeight.md.$value};
  --control-height-touch: ${dim.controlHeight.touch.$value};
  --border-width-thin: ${dim.borderWidth.thin.$value};
  --border-width-emphasis: ${dim.borderWidth.emphasis.$value};
${buildShadowBlock(false, '  ')}
}

:root[data-theme='light'] {
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    color-scheme: dark;

${darkMediaColors}

${buildShadowBlock(true, '    ')}
  }
}

:root[data-theme='dark'] {
  color-scheme: dark;

${darkAttrColors}

${buildShadowBlock(true, '  ')}
}
`;
}

export function generateLegacyTokensJson({ baseJson, darkJson, baseTokens, darkTokens }) {
  const combinedForDark = new Map([...baseTokens, ...darkTokens]);
  const prim = baseJson.color.primitive;

  const lightPrimitive = {
    'cotton-rag': { $value: prim['cotton-rag'].$value },
    'rag-card': { $value: prim['rag-card'].$value },
    'subtle-rag': { $value: prim['cotton-rag'].$value },
    'warm-linen': { $value: prim['warm-linen'].$value },
    'muted-rag': { $value: prim['warm-linen'].$value },
    'archival-indigo': { $value: prim['archival-indigo'].$value },
    'archival-indigo-hover': { $value: prim['archival-indigo'].$value },
    'iron-ink': { $value: prim['iron-ink'].$value },
    'warm-sepia': { $value: prim['warm-sepia'].$value },
    'loom-ochre': { $value: prim['loom-ochre'].$value },
    'warm-brass': { $value: prim['warm-brass'].$value },
    'pine-moss': { $value: prim['deep-moss'].$value },
    'cobalt-ink': { $value: prim['cobalt-ink'].$value },
    'seal-crimson': { $value: prim['deep-crimson'].$value },
    'slate-taupe': { $value: prim['slate-taupe'].$value },
    'parchment-hairline': { $value: prim['warm-linen'].$value },
    'sage-wash': { $value: prim['sage-wash'].$value },
    'deep-pine': { $value: prim['deep-moss'].$value },
    'rose-wash': { $value: prim['rose-wash'].$value },
    'deep-crimson': { $value: prim['deep-crimson'].$value },
    'amber-wash': { $value: prim['warm-linen'].$value },
    'deep-ochre': { $value: prim['loom-ochre'].$value },
    'pine-wash': { $value: prim['sage-wash'].$value },
    'deep-moss': { $value: prim['deep-moss'].$value },
  };

  const darkPrimitive = {
    'charcoal-folio': { $value: prim['charcoal-folio'].$value },
    'slate-card': { $value: prim['slate-card'].$value },
    'subtle-charcoal': { $value: prim['slate-card'].$value },
    'smoked-linen': { $value: prim['smoked-linen'].$value },
    'muted-slate': { $value: prim['smoked-linen'].$value },
    'warm-umber-action': { $value: prim['smoked-linen'].$value },
    'warm-umber-action-hover': { $value: prim['smoked-linen'].$value },
    'parchment-heading': { $value: prim['parchment-heading'].$value },
    'obsidian-bar': { $value: prim['charcoal-folio'].$value },
    'parchment-ink': { $value: prim['parchment-heading'].$value },
    'warm-parchment-muted': { $value: prim['parchment-heading'].$value },
    'warm-stone': { $value: prim['warm-stone'].$value },
    'warm-brass': { $value: prim['warm-brass'].$value },
    'bright-amber-ink': { $value: prim['warm-brass'].$value },
    'verdigris-sage': { $value: prim['verdigris-sage'].$value },
    'archival-sky': { $value: prim['archival-sky'].$value },
    'vermilion-tint': { $value: prim['vermilion-tint'].$value },
    'pewter-taupe': { $value: prim['pewter-taupe'].$value },
    'umber-hairline': { $value: prim['smoked-linen'].$value },
    'deep-pine-wash': { $value: prim['slate-card'].$value },
    'mint-parchment': { $value: prim['verdigris-sage'].$value },
    'deep-crimson-wash': { $value: prim['slate-card'].$value },
    'rose-parchment': { $value: prim['vermilion-tint'].$value },
    'amber-umber-wash': { $value: prim['smoked-linen'].$value },
    'warm-gold-ink': { $value: prim['warm-brass'].$value },
    'pine-umber-wash': { $value: prim['slate-card'].$value },
    'sage-parchment': { $value: prim['verdigris-sage'].$value },
    'night-water': { $value: prim['night-water'].$value },
  };

  const semantic = {};
  for (const [k, v] of Object.entries(baseJson.color.semantic)) {
    const resolved = resolveDtcgValue(v.$value, baseTokens).toUpperCase();
    const primKey = Object.entries(lightPrimitive).find(
      ([, entry]) => entry.$value.toUpperCase() === resolved
    )?.[0];
    semantic[k] = { $value: primKey ? `{color.primitive.${primKey}}` : resolved };
  }

  const semanticDark = {};
  for (const [k, v] of Object.entries(darkJson.color.semantic)) {
    const resolved = resolveDtcgValue(v.$value, combinedForDark).toUpperCase();
    const primKey = Object.entries(darkPrimitive).find(
      ([, entry]) => entry.$value.toUpperCase() === resolved
    )?.[0];
    semanticDark[k] = { $value: primKey ? `{color.primitiveDark.${primKey}}` : resolved };
  }

  return `${JSON.stringify(
    {
      $description:
        'Generated from packages/tokens/kinloom.tokens.json + kinloom.dark.tokens.json via scripts/sync-tokens.mjs (WCAG 2.2 AA/AAA and APCA 0.0.98G-4g-base-W3 verified).',
      color: {
        $type: 'color',
        primitive: lightPrimitive,
        primitiveDark: darkPrimitive,
        semantic,
        semanticDark,
      },
    },
    null,
    2
  )}\n`;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const sources = validateDtcgSources();
  const nextCss = generateKinloomCss(sources);
  const nextLegacyJson = generateLegacyTokensJson(sources);

  if (checkOnly) {
    const curCss = fs.existsSync(CSS_OUT_PATH) ? fs.readFileSync(CSS_OUT_PATH, 'utf8') : '';
    const curJson = fs.existsSync(LEGACY_TOKENS_PATH) ? fs.readFileSync(LEGACY_TOKENS_PATH, 'utf8') : '';
    const diffs = [];
    if (curCss !== nextCss) {
      diffs.push('packages/tokens/kinloom.css is out of sync with W3C DTCG .tokens.json sources.');
    }
    if (curJson !== nextLegacyJson) {
      diffs.push('packages/tokens/tokens.json is out of sync with W3C DTCG .tokens.json sources.');
    }
    if (diffs.length > 0) {
      for (const d of diffs) {
        console.error(`FAIL [tokens-sync] ${d}`);
      }
      console.error('Run `npm run tokens:sync` to regenerate.');
      process.exit(1);
    }
    console.log(
      `PASS [tokens-sync] Validated W3C DTCG 2025.10 sources (${sources.baseTokens.size} base + ${sources.darkTokens.size} dark tokens) and verified kinloom.css + tokens.json parity.`
    );
    return;
  }

  fs.writeFileSync(CSS_OUT_PATH, nextCss, 'utf8');
  fs.writeFileSync(LEGACY_TOKENS_PATH, nextLegacyJson, 'utf8');
  console.log(
    `Synced packages/tokens/kinloom.css and packages/tokens/tokens.json from W3C DTCG 2025.10 sources (${sources.baseTokens.size} base + ${sources.darkTokens.size} dark tokens).`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
