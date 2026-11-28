export type BrandSurface = 'parchment' | 'navy';
export type BrandIconVariant = 'any' | 'apple' | 'maskable';
export type FaviconColorMode = 'adaptive' | 'light' | 'dark';

export const KINLOOM_BRAND_PALETTE = {
  parchment: '#F5EFE2',
  ivory: '#FCF9F2',
  linen: '#EAE1CE',
  charcoalFolio: '#171614',
  navy: '#1B2A41',
  navyElevated: '#20324D',
  ochre: '#7A4612',
  pine: '#2F5245',
  inkPrimary: '#23272E',
  inkSecondary: '#4E4A42',
  inkInverse: '#FCF9F2',
  inkInverseMuted: '#D6CEBE',
  ruleLight: '#D6CEBE',
  ruleDark: '#334663',
  ruleDarkChrome: '#8FA6C4',
} as const;

export const KINLOOM_OG_DIMENSIONS = {
  width: 1200,
  height: 630,
  safeX: 60,
  safeY: 15,
  safeWidth: 1080,
  safeHeight: 600,
  recommendedMaxBytes: 300 * 1024,
} as const;

export const KINLOOM_ICON_SIZES = {
  ico: [16, 32, 48] as const,
  appleTouch: 180,
  pwaSmall: 192,
  pwaLarge: 512,
  maskable: 512,
  maskableSafeRatio: 0.8,
} as const;

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function normalizeHex(candidate: string | undefined, fallback: string): string {
  if (candidate && HEX_COLOR_RE.test(candidate.trim())) {
    return candidate.trim().toUpperCase();
  }
  return fallback;
}

function parseHexRgb(hex: string): readonly [number, number, number] {
  const normalized = normalizeHex(hex, KINLOOM_BRAND_PALETTE.ochre);
  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  ];
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHexRgb(hex);
  const toLinear = (channel: number): number => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexA);
  const lumB = relativeLuminance(hexB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

function rgbToHsl(r: number, g: number, b: number): readonly [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) {
    return [0, 0, l];
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) {
    h = (gn - bn) / d + (gn < bn ? 6 : 0);
  } else if (max === gn) {
    h = (bn - rn) / d + 2;
  } else {
    h = (rn - gn) / d + 4;
  }
  return [h / 6, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const hue2rgb = (p: number, q: number, rawT: number): number => {
    const t = rawT < 0 ? rawT + 1 : rawT > 1 ? rawT - 1 : rawT;
    if (t < 1 / 6) {
      return p + (q - p) * 6 * t;
    }
    if (t < 1 / 2) {
      return q;
    }
    if (t < 2 / 3) {
      return p + (q - p) * (2 / 3 - t) * 6;
    }
    return p;
  };
  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = l;
    g = l;
    b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const toByteHex = (unit: number): string =>
    Math.round(Math.min(255, Math.max(0, unit * 255)))
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `#${toByteHex(r)}${toByteHex(g)}${toByteHex(b)}`;
}

/**
 * Lightens a dark site accent in HSL while preserving its hue so the favicon accent weave
 * meets at least `minContrast` (default 6.0:1, strictly exceeding WCAG AA 4.5:1) on dark tiles.
 */
export function deriveDarkModeFaviconAccent(
  hex: string,
  bgHex: string = KINLOOM_BRAND_PALETTE.navyElevated,
  minContrast = 6.0
): string {
  const normalized = normalizeHex(hex, KINLOOM_BRAND_PALETTE.ochre);
  const normalizedBg = normalizeHex(bgHex, KINLOOM_BRAND_PALETTE.navyElevated);
  if (contrastRatio(normalized, normalizedBg) >= minContrast) {
    return normalized;
  }
  const [r, g, b] = parseHexRgb(normalized);
  const [h, s, l] = rgbToHsl(r, g, b);
  let lo = l;
  let hi = 1;
  let best = '#FFFFFF';
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    const candidate = hslToHex(h, s, mid);
    if (contrastRatio(candidate, normalizedBg) >= minContrast) {
      best = candidate;
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return best;
}

export function renderKinloomMarkPaths(primaryColor: string, accentColor: string): string {
  return [
    `<path d="M8 2.5V13.5M8 18.5V21.5" stroke="${primaryColor}" stroke-width="2.5" stroke-linecap="round"/>`,
    `<path d="M16 2.5V5.5M16 10.5V21.5" stroke="${primaryColor}" stroke-width="2.5" stroke-linecap="round"/>`,
    `<path d="M2.5 8H5.5M10.5 8H21.5" stroke="${accentColor}" stroke-width="2.5" stroke-linecap="round"/>`,
    `<path d="M2.5 16H13.5M18.5 16H21.5" stroke="${primaryColor}" stroke-width="2.5" stroke-linecap="round"/>`,
  ].join('\n    ');
}

export interface RenderFaviconSvgOptions {
  readonly accent?: string;
  readonly accentDark?: string;
  readonly label?: string;
  readonly customMarkInnerSvg?: string;
  readonly mode?: FaviconColorMode;
}

export function renderFaviconSvg(options?: RenderFaviconSvgOptions): string {
  const mode: FaviconColorMode = options?.mode ?? 'adaptive';
  const accent = normalizeHex(options?.accent, KINLOOM_BRAND_PALETTE.ochre);
  const darkAccent = options?.accentDark
    ? normalizeHex(
        options.accentDark,
        deriveDarkModeFaviconAccent(accent, KINLOOM_BRAND_PALETTE.navyElevated)
      )
    : deriveDarkModeFaviconAccent(accent, KINLOOM_BRAND_PALETTE.navyElevated);
  const label = escapeXml(options?.label?.trim() || 'Kinloom icon');
  const markContent = options?.customMarkInnerSvg
    ? options.customMarkInnerSvg
    : [
        '<path class="kl-warp" d="M8 2.5V13.5M8 18.5V21.5" stroke-width="2.5" stroke-linecap="round"/>',
        '<path class="kl-warp" d="M16 2.5V5.5M16 10.5V21.5" stroke-width="2.5" stroke-linecap="round"/>',
        '<path class="kl-accent" d="M2.5 8H5.5M10.5 8H21.5" stroke-width="2.5" stroke-linecap="round"/>',
        '<path class="kl-warp" d="M2.5 16H13.5M18.5 16H21.5" stroke-width="2.5" stroke-linecap="round"/>',
      ].join('\n    ');

  let styleRules: string;
  if (mode === 'light') {
    styleRules = [
      `    .kl-bg { fill: ${KINLOOM_BRAND_PALETTE.parchment}; stroke: ${KINLOOM_BRAND_PALETTE.ruleLight}; }`,
      `    .kl-warp { stroke: ${KINLOOM_BRAND_PALETTE.navy}; }`,
      `    .kl-accent { stroke: ${accent}; }`,
    ].join('\n');
  } else if (mode === 'dark') {
    styleRules = [
      `    .kl-bg { fill: ${KINLOOM_BRAND_PALETTE.navyElevated}; stroke: ${KINLOOM_BRAND_PALETTE.ruleDarkChrome}; }`,
      `    .kl-warp { stroke: ${KINLOOM_BRAND_PALETTE.ivory}; }`,
      `    .kl-accent { stroke: ${darkAccent}; }`,
    ].join('\n');
  } else {
    styleRules = [
      `    .kl-bg { fill: ${KINLOOM_BRAND_PALETTE.parchment}; stroke: ${KINLOOM_BRAND_PALETTE.ruleLight}; }`,
      `    .kl-warp { stroke: ${KINLOOM_BRAND_PALETTE.navy}; }`,
      `    .kl-accent { stroke: ${accent}; }`,
      '    @media (prefers-color-scheme: dark) {',
      `      .kl-bg { fill: ${KINLOOM_BRAND_PALETTE.navyElevated}; stroke: ${KINLOOM_BRAND_PALETTE.ruleDarkChrome}; }`,
      `      .kl-warp { stroke: ${KINLOOM_BRAND_PALETTE.ivory}; }`,
      `      .kl-accent { stroke: ${darkAccent}; }`,
      '    }',
    ].join('\n');
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" fill="none" role="img" aria-label="${label}">
  <style>
${styleRules}
  </style>
  <rect class="kl-bg" x="0.75" y="0.75" width="30.5" height="30.5" rx="6" stroke-width="1.5"/>
  <g transform="translate(4, 4)">
    ${markContent}
  </g>
</svg>
`;
}

export function renderLightFaviconSvg(options?: Omit<RenderFaviconSvgOptions, 'mode'>): string {
  return renderFaviconSvg({ ...options, mode: 'light' });
}

export function renderDarkFaviconSvg(options?: Omit<RenderFaviconSvgOptions, 'mode'>): string {
  return renderFaviconSvg({ ...options, mode: 'dark' });
}

export function renderIconSvg(options: {
  size: number;
  variant: BrandIconVariant;
  surface?: BrandSurface;
  accent?: string;
  transparentBackground?: boolean;
  customMarkInnerSvg?: string;
}): string {
  const { size, variant, transparentBackground = false } = options;
  const surface: BrandSurface = options.surface ?? 'parchment';
  const accent = normalizeHex(options.accent, KINLOOM_BRAND_PALETTE.ochre);
  const bgColor = surface === 'navy' ? KINLOOM_BRAND_PALETTE.navy : KINLOOM_BRAND_PALETTE.parchment;
  const borderColor = surface === 'navy' ? KINLOOM_BRAND_PALETTE.ruleDark : KINLOOM_BRAND_PALETTE.ruleLight;
  const primaryStroke = surface === 'navy' ? KINLOOM_BRAND_PALETTE.ivory : KINLOOM_BRAND_PALETTE.navy;

  const markRatio =
    variant === 'maskable' ? 0.52 : variant === 'apple' ? 0.68 : transparentBackground ? 0.8 : 0.72;
  const markSize = size * markRatio;
  const scale = markSize / 24;
  const offset = (size - markSize) / 2;

  const backgroundMarkup = transparentBackground
    ? ''
    : variant === 'apple' || variant === 'maskable'
      ? `<rect x="0" y="0" width="${size}" height="${size}" fill="${bgColor}"/>`
      : `<rect x="${(size * 0.02).toFixed(2)}" y="${(size * 0.02).toFixed(2)}" width="${(size * 0.96).toFixed(2)}" height="${(size * 0.96).toFixed(2)}" rx="${(size * 0.18).toFixed(2)}" fill="${bgColor}" stroke="${borderColor}" stroke-width="${Math.max(1, size * 0.025).toFixed(2)}"/>`;

  const markContent = options.customMarkInnerSvg
    ? options.customMarkInnerSvg
    : renderKinloomMarkPaths(primaryStroke, accent);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" fill="none">
  ${backgroundMarkup}
  <g transform="translate(${offset.toFixed(2)}, ${offset.toFixed(2)}) scale(${scale.toFixed(4)})">
    ${markContent}
  </g>
</svg>
`;
}

function wrapTextLines(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const [firstWord] = words;
  if (!firstWord) {
    return [];
  }
  const lines: string[] = [];
  let current = firstWord;

  for (let i = 1; i < words.length; i += 1) {
    const word = words[i];
    if (!word) {
      continue;
    }
    if (`${current} ${word}`.length <= maxCharsPerLine) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) {
        const remaining = [current, ...words.slice(i + 1)].join(' ');
        lines.push(
          remaining.length > maxCharsPerLine
            ? `${remaining.slice(0, maxCharsPerLine - 1).trimEnd()}…`
            : remaining
        );
        return lines;
      }
    }
  }
  lines.push(current);
  return lines.slice(0, maxLines);
}

export function renderOgCardSvg(options: {
  title: string;
  subtitle: string;
  metadataLine?: string;
  footerCredit?: string | null;
  kicker?: string;
  surface?: BrandSurface;
  accent?: string;
  customMarkInnerSvg?: string;
  vignetteDataUri?: string;
}): string {
  const { width, height } = KINLOOM_OG_DIMENSIONS;
  const surface: BrandSurface = options.surface ?? 'parchment';
  const accent = normalizeHex(options.accent, KINLOOM_BRAND_PALETTE.ochre);
  const isNavy = surface === 'navy';
  const bg = isNavy ? KINLOOM_BRAND_PALETTE.navy : KINLOOM_BRAND_PALETTE.parchment;
  const cardBg = isNavy ? '#22344F' : KINLOOM_BRAND_PALETTE.ivory;
  const panelBg = isNavy ? '#17253A' : KINLOOM_BRAND_PALETTE.parchment;
  const ruleColor = isNavy ? KINLOOM_BRAND_PALETTE.ruleDark : KINLOOM_BRAND_PALETTE.ruleLight;
  const innerRuleColor = isNavy ? '#2B3F5E' : '#E5DAC5';
  const topBarColor = isNavy ? KINLOOM_BRAND_PALETTE.ivory : KINLOOM_BRAND_PALETTE.navy;
  const titleColor = isNavy ? KINLOOM_BRAND_PALETTE.inkInverse : KINLOOM_BRAND_PALETTE.inkPrimary;
  const subtitleColor = isNavy ? KINLOOM_BRAND_PALETTE.inkInverseMuted : KINLOOM_BRAND_PALETTE.inkSecondary;
  const markPrimary = isNavy ? KINLOOM_BRAND_PALETTE.ivory : KINLOOM_BRAND_PALETTE.navy;
  const treeInk = isNavy ? KINLOOM_BRAND_PALETTE.ivory : KINLOOM_BRAND_PALETTE.navy;

  const markContent = options.customMarkInnerSvg
    ? options.customMarkInnerSvg
    : renderKinloomMarkPaths(markPrimary, accent);

  const serifFont = `'Newsreader', Georgia, 'Times New Roman', serif`;
  const monoFont = `'IBM Plex Mono', 'DejaVu Sans Mono', ui-monospace, monospace`;

  const kickerText = (options.kicker?.trim() || 'FAMILY ARCHIVE').toUpperCase();
  const titleLines = wrapTextLines(options.title, 20, 2);
  const longestTitleLine = Math.max(...titleLines.map((line) => line.length), 0);
  const titleFontSize =
    titleLines.length === 1 ? (longestTitleLine > 15 ? 78 : 92) : longestTitleLine > 15 ? 76 : 86;
  const titleStartY = titleLines.length === 1 ? 298 : 264;
  const titleLineStep = titleFontSize + 14;
  const titleSvg = titleLines
    .map(
      (line, idx) =>
        `<text x="80" y="${titleStartY + idx * titleLineStep}" fill="${titleColor}" font-family="${serifFont}" font-size="${titleFontSize}" font-weight="700">${escapeXml(line)}</text>`
    )
    .join('\n  ');

  const ruleY = titleStartY + (titleLines.length - 1) * titleLineStep + 34;
  const subtitleLines = wrapTextLines(options.subtitle, 30, 2);
  const subtitleFontSize = subtitleLines.some((line) => line.length > 26) ? 40 : 44;
  const subtitleY = ruleY + 58;
  const subtitleSvg = subtitleLines
    .map(
      (line, idx) =>
        `<text x="80" y="${subtitleY + idx * (subtitleFontSize + 10)}" fill="${subtitleColor}" font-family="${serifFont}" font-size="${subtitleFontSize}" font-weight="500">${escapeXml(line)}</text>`
    )
    .join('\n  ');

  const metaY = Math.min(subtitleY + (subtitleLines.length - 1) * (subtitleFontSize + 10) + 46, 548);
  const metaSvg = options.metadataLine?.trim()
    ? `<text x="80" y="${metaY}" fill="${titleColor}" font-family="${monoFont}" font-size="22" font-weight="600" letter-spacing="1.6">${escapeXml(options.metadataLine.trim().toUpperCase())}</text>`
    : '';

  const footerCreditSvg = options.footerCredit?.trim()
    ? `<text x="1146" y="576" text-anchor="end" fill="${subtitleColor}" opacity="0.58" font-family="${monoFont}" font-size="13" letter-spacing="1.4">${escapeXml(options.footerCredit.trim().toUpperCase())}</text>`
    : '';

  const rightPanelDefs = options.vignetteDataUri
    ? `  <defs>
    <clipPath id="kl-vignette-clip">
      <rect x="816" y="100" width="294" height="430" rx="2"/>
    </clipPath>
  </defs>`
    : '';

  const rightPanelSvg = options.vignetteDataUri
    ? `  <rect x="808" y="92" width="310" height="446" rx="4" fill="${panelBg}" stroke="${ruleColor}" stroke-width="1.5"/>
  <image href="${escapeXml(options.vignetteDataUri)}" x="816" y="100" width="294" height="430" preserveAspectRatio="xMidYMid slice" clip-path="url(#kl-vignette-clip)"/>`
    : `  <g transform="translate(808, 92)">
    <rect x="0" y="0" width="310" height="446" rx="4" fill="${panelBg}" stroke="${ruleColor}" stroke-width="1.5"/>
    <path d="M155 376 V300 M85 300 H225 M85 300 V220 M225 300 V220 M45 220 H125 M185 220 H265 M45 220 V140 M125 220 V140 M185 220 V140 M265 220 V140 M45 140 V82 M125 140 V82 M185 140 V82 M265 140 V82" stroke="${treeInk}" stroke-width="3" stroke-linecap="round" opacity="0.28"/>
    <path d="M155 376 V300 H85 V220 H125 V140" stroke="${accent}" stroke-width="4" stroke-linecap="round" opacity="0.88"/>
    <circle cx="155" cy="376" r="14" fill="${accent}"/>
    <circle cx="85" cy="300" r="11" fill="${treeInk}"/>
    <circle cx="225" cy="300" r="11" fill="${treeInk}" opacity="0.45"/>
    <circle cx="45" cy="220" r="9" fill="${treeInk}" opacity="0.45"/>
    <circle cx="125" cy="220" r="10" fill="${accent}"/>
    <circle cx="185" cy="220" r="9" fill="${treeInk}" opacity="0.45"/>
    <circle cx="265" cy="220" r="9" fill="${treeInk}" opacity="0.45"/>
    <circle cx="45" cy="140" r="7" fill="${treeInk}" opacity="0.35"/>
    <circle cx="125" cy="140" r="8" fill="${treeInk}"/>
    <circle cx="185" cy="140" r="7" fill="${treeInk}" opacity="0.35"/>
    <circle cx="265" cy="140" r="7" fill="${treeInk}" opacity="0.35"/>
    <circle cx="45" cy="82" r="5" fill="${treeInk}" opacity="0.25"/>
    <circle cx="125" cy="82" r="5" fill="${treeInk}" opacity="0.25"/>
    <circle cx="185" cy="82" r="5" fill="${treeInk}" opacity="0.25"/>
    <circle cx="265" cy="82" r="5" fill="${treeInk}" opacity="0.25"/>
  </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" fill="none">
${rightPanelDefs}
  <rect x="0" y="0" width="${width}" height="${height}" fill="${bg}"/>
  <rect x="28" y="28" width="${width - 56}" height="${height - 56}" fill="${cardBg}" stroke="${ruleColor}" stroke-width="2"/>
  <rect x="38" y="38" width="${width - 76}" height="${height - 76}" stroke="${innerRuleColor}" stroke-width="1"/>
  <rect x="28" y="28" width="${width - 56}" height="8" fill="${topBarColor}"/>
  <rect x="28" y="28" width="320" height="8" fill="${accent}"/>
  <g transform="translate(80, 86) scale(3.2)">
    ${markContent}
  </g>
  <text x="178" y="136" fill="${accent}" font-family="${monoFont}" font-size="24" font-weight="600" letter-spacing="2.4">${escapeXml(kickerText)}</text>
  ${titleSvg}
  <line x1="80" y1="${ruleY}" x2="740" y2="${ruleY}" stroke="${accent}" stroke-width="5"/>
  ${subtitleSvg}
  ${metaSvg}
${rightPanelSvg}
  ${footerCreditSvg}
</svg>
`;
}
