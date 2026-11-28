import type {
  CaptureThemeAudit,
  DarkThemeVerificationStatus,
  DarkThemeVerificationSummary,
  IncludeScope,
  ManifestCaptureEntry,
  ScreenshotCategory,
  ScreenshotsCommandResult,
  ScreenshotsManifest,
  ScreenshotTheme,
  ViewportSpec,
} from './types.js';

export interface ParsedRgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const DARK_SURFACE_LUMINANCE_THRESHOLD = 0.25;

export function parseCssRgbColor(raw: string | null | undefined): ParsedRgbColor | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  const rgbMatch =
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?\s*\)$/.exec(
      trimmed
    );
  if (rgbMatch) {
    const r = Number(rgbMatch[1]);
    const g = Number(rgbMatch[2]);
    const b = Number(rgbMatch[3]);
    const a = rgbMatch[4] === undefined ? 1 : Number(rgbMatch[4]);
    if (
      [r, g, b, a].some((v) => !Number.isFinite(v)) ||
      r < 0 ||
      r > 255 ||
      g < 0 ||
      g > 255 ||
      b < 0 ||
      b > 255 ||
      a <= 0
    ) {
      return null;
    }
    return { r, g, b, a };
  }
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(trimmed);
  if (hexMatch) {
    const hex = hexMatch[1] ?? '';
    const expanded = hex.length === 3 ? hex.replace(/./g, (ch) => `${ch}${ch}`) : hex;
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16),
      g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16),
      a: 1,
    };
  }
  return null;
}

export function computeRelativeLuminance(rgb: {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}): number {
  const linearize = (channel: number): number => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(rgb.r) + 0.7152 * linearize(rgb.g) + 0.0722 * linearize(rgb.b);
}

export function computeContrastRatio(lumA: number, lumB: number): number {
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

export function buildCaptureThemeAudit(
  probe: {
    readonly backgroundColor: string | null;
    readonly textColor: string | null;
    readonly dataTheme: string | null;
    readonly prefersDark: boolean | null;
  } | null,
  contentSha256?: string
): CaptureThemeAudit | undefined {
  if (!probe && !contentSha256) {
    return undefined;
  }
  const bgRgb = parseCssRgbColor(probe?.backgroundColor);
  const fgRgb = parseCssRgbColor(probe?.textColor);
  const backgroundLuminance = bgRgb ? Math.round(computeRelativeLuminance(bgRgb) * 10_000) / 10_000 : null;
  const textLuminance = fgRgb ? computeRelativeLuminance(fgRgb) : null;
  const contrastRatio =
    backgroundLuminance !== null && textLuminance !== null
      ? computeContrastRatio(backgroundLuminance, textLuminance)
      : null;
  const isDarkSurface =
    backgroundLuminance !== null ? backgroundLuminance < DARK_SURFACE_LUMINANCE_THRESHOLD : null;

  return {
    backgroundColor: probe?.backgroundColor ?? null,
    textColor: probe?.textColor ?? null,
    backgroundLuminance,
    contrastRatio,
    isDarkSurface,
    dataTheme: probe?.dataTheme ?? null,
    prefersDark: probe?.prefersDark ?? null,
    ...(contentSha256 ? { contentSha256 } : {}),
  };
}

export function computeDarkThemeVerification(
  themes: readonly ScreenshotTheme[],
  captures: readonly ManifestCaptureEntry[]
): DarkThemeVerificationSummary {
  if (!themes.includes('dark')) {
    return {
      status: 'not-requested',
      darkCaptureCount: 0,
      pairedCaptureCount: 0,
      distinctFromLightCount: 0,
      identicalToLightCount: 0,
      darkSurfaceVerifiedCount: 0,
      lightCanvasInDarkModeCount: 0,
      minDarkContrastRatio: null,
      identicalCaptureIds: [],
    };
  }

  const lightByKey = new Map<string, ManifestCaptureEntry>();
  const darkCaptures: ManifestCaptureEntry[] = [];

  for (const entry of captures) {
    if (entry.status !== 'captured' || entry.slug === 'theme-toggle') {
      continue;
    }
    const pairKey = `${entry.category}:${entry.slug}:${entry.state}@${entry.viewport}`;
    if (entry.theme === 'light') {
      lightByKey.set(pairKey, entry);
    } else {
      darkCaptures.push(entry);
    }
  }

  let pairedCaptureCount = 0;
  let distinctFromLightCount = 0;
  let identicalToLightCount = 0;
  let darkSurfaceVerifiedCount = 0;
  let lightCanvasInDarkModeCount = 0;
  let minDarkContrastRatio: number | null = null;
  const identicalCaptureIds: string[] = [];

  for (const darkEntry of darkCaptures) {
    const pairKey = `${darkEntry.category}:${darkEntry.slug}:${darkEntry.state}@${darkEntry.viewport}`;
    const audit = darkEntry.themeAudit;

    if (audit?.isDarkSurface === true) {
      darkSurfaceVerifiedCount += 1;
    } else if (audit?.isDarkSurface === false) {
      lightCanvasInDarkModeCount += 1;
    }
    if (typeof audit?.contrastRatio === 'number') {
      minDarkContrastRatio =
        minDarkContrastRatio === null
          ? audit.contrastRatio
          : Math.min(minDarkContrastRatio, audit.contrastRatio);
    }

    const lightEntry = lightByKey.get(pairKey);
    const lightHash = lightEntry?.themeAudit?.contentSha256;
    const darkHash = audit?.contentSha256;
    if (lightEntry && lightHash && darkHash) {
      pairedCaptureCount += 1;
      if (lightHash === darkHash) {
        identicalToLightCount += 1;
        identicalCaptureIds.push(`${darkEntry.id}@${darkEntry.viewport}`);
      } else {
        distinctFromLightCount += 1;
      }
    }
  }

  let status: DarkThemeVerificationStatus;
  if (
    darkCaptures.length === 0 ||
    (pairedCaptureCount === 0 && darkSurfaceVerifiedCount === 0 && lightCanvasInDarkModeCount === 0)
  ) {
    status = 'unverified';
  } else if (
    (pairedCaptureCount > 0 && distinctFromLightCount === 0) ||
    (distinctFromLightCount === 0 && darkSurfaceVerifiedCount === 0 && lightCanvasInDarkModeCount > 0)
  ) {
    status = 'noop';
  } else if (identicalToLightCount > 0 || lightCanvasInDarkModeCount > 0) {
    status = 'partial-noop';
  } else {
    status = 'verified';
  }

  return {
    status,
    darkCaptureCount: darkCaptures.length,
    pairedCaptureCount,
    distinctFromLightCount,
    identicalToLightCount,
    darkSurfaceVerifiedCount,
    lightCanvasInDarkModeCount,
    minDarkContrastRatio,
    identicalCaptureIds,
  };
}

export function escapeHtml(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function buildScreenshotsManifest(input: {
  readonly targetUrl: string;
  readonly generatedAt: string;
  readonly viewports: readonly ViewportSpec[];
  readonly themes: readonly ScreenshotTheme[];
  readonly include: readonly IncludeScope[];
  readonly captures: readonly ManifestCaptureEntry[];
}): ScreenshotsManifest {
  let captured = 0;
  let skipped = 0;
  let failed = 0;
  let consoleErrorCount = 0;
  let failedRequestCount = 0;
  const byCategory: Record<ScreenshotCategory, number> = {
    page: 0,
    component: 0,
    plugin: 0,
  };

  for (const entry of input.captures) {
    byCategory[entry.category] += 1;
    if (entry.status === 'captured') {
      captured += 1;
    } else if (entry.status === 'skipped') {
      skipped += 1;
    } else {
      failed += 1;
    }
    consoleErrorCount += entry.consoleErrors.length;
    failedRequestCount += entry.failedRequests.length;
  }

  return {
    schemaVersion: 1,
    targetUrl: input.targetUrl,
    generatedAt: input.generatedAt,
    viewports: input.viewports,
    themes: input.themes,
    include: input.include,
    summary: {
      total: input.captures.length,
      captured,
      skipped,
      failed,
      byCategory,
      consoleErrorCount,
      failedRequestCount,
    },
    darkThemeVerification: computeDarkThemeVerification(input.themes, input.captures),
    captures: input.captures,
  };
}

interface CaptureGroup {
  readonly groupKey: string;
  readonly category: ScreenshotCategory;
  readonly label: string;
  readonly slug: string;
  readonly state: string;
  readonly route: string;
  readonly entries: ManifestCaptureEntry[];
}

function groupCapturesForSheet(captures: readonly ManifestCaptureEntry[]): readonly CaptureGroup[] {
  const map = new Map<string, CaptureGroup>();
  for (const entry of captures) {
    const groupKey = `${entry.category}:${entry.slug}:${entry.state}`;
    const existing = map.get(groupKey);
    if (existing) {
      existing.entries.push(entry);
    } else {
      map.set(groupKey, {
        groupKey,
        category: entry.category,
        label: entry.label,
        slug: entry.slug,
        state: entry.state,
        route: entry.route,
        entries: [entry],
      });
    }
  }
  return [...map.values()];
}

function renderCardHtml(entry: ManifestCaptureEntry, identicalDarkIds: ReadonlySet<string>): string {
  const isIdenticalDark = entry.theme === 'dark' && identicalDarkIds.has(`${entry.id}@${entry.viewport}`);
  const hasErrors =
    entry.status === 'failed' ||
    isIdenticalDark ||
    entry.consoleErrors.length > 0 ||
    entry.failedRequests.length > 0;
  const safeFile = entry.file ? escapeHtml(entry.file) : '';
  const safeLabel = escapeHtml(entry.label);
  const safeRoute = escapeHtml(entry.route);
  const safeState = escapeHtml(entry.state);
  const safeViewport = escapeHtml(entry.viewport);
  const safeTheme = escapeHtml(entry.theme);
  const safeStatus = escapeHtml(entry.status);
  const searchHaystack = escapeHtml(
    `${entry.label} ${entry.slug} ${entry.state} ${entry.route} ${entry.viewport} ${entry.theme} ${entry.category}`.toLowerCase()
  );

  const errorDetails = [
    ...(isIdenticalDark ? ['Dark capture bytes are identical to light capture (dark-theme no-op).'] : []),
    ...(entry.fallbackUsed === 'viewport-after-fullpage-timeout'
      ? [entry.reason ?? 'Full-page capture timed out; captured viewport fallback.']
      : []),
    ...entry.consoleErrors.map((msg) => `Console error: ${msg}`),
    ...entry.failedRequests.map((req) => `Failed request: ${req}`),
  ];

  const diagHtml =
    errorDetails.length > 0
      ? `<details class="diag"><summary class="badge badge-warn">${errorDetails.length} issue${errorDetails.length === 1 ? '' : 's'}</summary><ul>${errorDetails
          .map((line) => `<li>${escapeHtml(line)}</li>`)
          .join('')}</ul></details>`
      : '';

  const fallbackBadge =
    entry.fallbackUsed === 'viewport-after-fullpage-timeout'
      ? `<span class="badge badge-warn">viewport fallback</span>`
      : '';
  const darkNoopBadge = isIdenticalDark ? `<span class="badge badge-warn">dark no-op</span>` : '';

  const mediaHtml =
    entry.status === 'captured' && entry.file
      ? `<button type="button" class="thumb-btn" data-zoom-src="${safeFile}" data-zoom-title="${safeLabel} (${safeViewport} · ${safeTheme})" data-zoom-meta="${safeRoute} · ${entry.width}x${entry.height} · ${entry.durationMs}ms"><img src="${safeFile}" alt="${safeLabel} — ${safeViewport} ${safeTheme}" loading="lazy" /></button>`
      : `<div class="placeholder placeholder-${safeStatus}"><strong>${safeStatus.toUpperCase()}</strong><span>${escapeHtml(entry.reason ?? 'Not captured')}</span></div>`;

  return `<article class="card" data-category="${entry.category}" data-viewport="${safeViewport}" data-theme="${safeTheme}" data-status="${safeStatus}" data-errors="${hasErrors ? '1' : '0'}" data-search="${searchHaystack}">
  <div class="card-head">
    <span class="badge">${safeViewport} ${entry.width}&times;${entry.height}</span>
    <span class="badge badge-theme-${safeTheme}">${safeTheme}</span>
    <span class="badge badge-status-${safeStatus}">${safeStatus}</span>
    ${fallbackBadge}${darkNoopBadge}
    <span class="dur">${entry.durationMs}ms</span>
  </div>
  ${mediaHtml}
  <div class="card-foot">
    <span class="meta-route">${safeRoute}</span>
    ${entry.state !== 'default' ? `<span class="meta-state">state: ${safeState}</span>` : ''}
    ${entry.file ? `<a class="open-raw" href="${safeFile}" target="_blank" rel="noopener">PNG</a>` : ''}
  </div>
  ${diagHtml}
</article>`;
}

export function renderContactSheetHtml(manifest: ScreenshotsManifest): string {
  const groups = groupCapturesForSheet(manifest.captures);
  const safeTarget = escapeHtml(manifest.targetUrl);
  const safeTimestamp = escapeHtml(manifest.generatedAt);
  const identicalDarkIds = new Set(manifest.darkThemeVerification?.identicalCaptureIds ?? []);
  const darkMetaSuffix =
    manifest.darkThemeVerification && manifest.darkThemeVerification.status !== 'not-requested'
      ? ` &middot; dark theme: ${escapeHtml(manifest.darkThemeVerification.status)}`
      : '';

  const viewportButtons = manifest.viewports
    .map(
      (vp) =>
        `<button type="button" class="pill" data-filter-viewport="${escapeHtml(vp.name)}">${escapeHtml(vp.name)} (${vp.width}&times;${vp.height})</button>`
    )
    .join('');

  const themeButtons = manifest.themes
    .map((theme) => `<button type="button" class="pill" data-filter-theme="${theme}">${theme}</button>`)
    .join('');

  const sectionsHtml = groups
    .map((group) => {
      const cardsHtml = group.entries.map((entry) => renderCardHtml(entry, identicalDarkIds)).join('\n');
      return `<section class="group" data-group-category="${group.category}">
  <header class="group-head">
    <div class="group-title-row">
      <span class="cat-pill cat-${group.category}">${group.category}</span>
      <h2>${escapeHtml(group.label)}</h2>
      ${group.state !== 'default' ? `<span class="state-chip">${escapeHtml(group.state)}</span>` : ''}
    </div>
    <code class="group-route">${escapeHtml(group.route)}</code>
  </header>
  <div class="strip">${cardsHtml}</div>
</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Kinloom UI Review Contact Sheet — ${safeTarget}</title>
<style>
  :root {
    --paper: #f5efe2; --card: #fcf9f2; --ink: #23272e; --muted: #58534a;
    --navy: #1b2a41; --accent: #7a4612; --line: #d6cebe;
    --ok-bg: #dfece6; --ok-fg: #1f4d3a; --warn-bg: #f6e2df; --warn-fg: #7f231b;
    --skip-bg: #ece6d9; --skip-fg: #58534a;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--paper); color: var(--ink); line-height: 1.45; }
  .topbar { background: var(--navy); color: #fcf9f2; padding: 14px 20px; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 8px 18px; }
  .topbar h1 { margin: 0; font-size: 1.1rem; font-weight: 600; }
  .topbar-meta { font-size: 0.82rem; opacity: 0.9; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .filters { position: sticky; top: 0; z-index: 20; background: rgba(252, 249, 242, 0.96); border-bottom: 1px solid var(--line); padding: 10px 20px; display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; backdrop-filter: blur(4px); }
  .filter-group { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
  .filter-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-right: 3px; font-weight: 600; }
  .pill { border: 1px solid var(--line); background: var(--card); color: var(--ink); border-radius: 999px; padding: 4px 10px; font-size: 0.78rem; cursor: pointer; }
  .pill.active { background: var(--navy); color: #fcf9f2; border-color: var(--navy); }
  .search-input { border: 1px solid var(--line); background: #fff; border-radius: 6px; padding: 5px 10px; font-size: 0.82rem; min-width: 210px; color: var(--ink); }
  .stats { margin-left: auto; font-size: 0.78rem; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { max-width: 1680px; margin: 0 auto; padding: 18px 20px 64px; }
  .group { margin-bottom: 26px; }
  .group[hidden] { display: none; }
  .group-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  .group-title-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .group-head h2 { margin: 0; font-size: 1rem; }
  .group-route { font-size: 0.78rem; color: var(--muted); background: var(--card); border: 1px solid var(--line); padding: 2px 7px; border-radius: 4px; }
  .cat-pill, .state-chip, .badge { font-size: 0.72rem; padding: 2px 7px; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cat-page { background: #e3eaf2; color: #1b2a41; }
  .cat-component { background: #f3e4c8; color: #6b3d0e; }
  .cat-plugin { background: #dfece6; color: #1f4d3a; }
  .state-chip { background: var(--skip-bg); color: var(--ink); }
  .strip { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; display: flex; flex-direction: column; }
  .card[hidden] { display: none; }
  .card-head { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; padding: 7px 9px; border-bottom: 1px solid var(--line); background: #f8f3e8; }
  .badge { background: #ece6d9; color: var(--ink); }
  .badge-theme-dark { background: #23272e; color: #fcf9f2; }
  .badge-status-captured { background: var(--ok-bg); color: var(--ok-fg); }
  .badge-status-skipped { background: var(--skip-bg); color: var(--skip-fg); }
  .badge-status-failed, .badge-warn { background: var(--warn-bg); color: var(--warn-fg); }
  .dur { margin-left: auto; font-size: 0.72rem; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .thumb-btn { border: 0; padding: 0; background: #e8e0cf; cursor: zoom-in; display: block; width: 100%; max-height: 360px; overflow: hidden; text-align: left; }
  .thumb-btn img { width: 100%; height: auto; display: block; object-fit: cover; object-position: top; }
  .placeholder { padding: 28px 14px; text-align: center; font-size: 0.82rem; color: var(--muted); display: flex; flex-direction: column; gap: 5px; min-height: 120px; justify-content: center; }
  .placeholder-failed { background: #fbf0ee; color: var(--warn-fg); }
  .card-foot { padding: 6px 9px; font-size: 0.75rem; color: var(--muted); display: flex; gap: 8px; align-items: center; border-top: 1px solid var(--line); }
  .meta-route { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .open-raw { margin-left: auto; color: var(--accent); font-weight: 600; text-decoration: none; }
  .diag { border-top: 1px solid var(--line); padding: 6px 9px; font-size: 0.74rem; background: #fff9f7; }
  .diag summary { cursor: pointer; list-style: none; }
  .diag ul { margin: 6px 0 0; padding-left: 16px; color: var(--warn-fg); word-break: break-word; }
  .lightbox { position: fixed; inset: 0; z-index: 50; background: rgba(20, 24, 30, 0.88); display: none; flex-direction: column; padding: 16px; }
  .lightbox.open { display: flex; }
  .lb-bar { display: flex; justify-content: space-between; align-items: center; color: #fcf9f2; gap: 12px; margin-bottom: 10px; }
  .lb-title { font-weight: 600; font-size: 0.95rem; }
  .lb-meta { font-size: 0.78rem; opacity: 0.85; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .lb-actions { display: flex; gap: 8px; }
  .lb-btn { border: 1px solid rgba(255,255,255,0.35); background: rgba(255,255,255,0.1); color: #fff; border-radius: 4px; padding: 5px 10px; cursor: pointer; }
  .lb-stage { flex: 1; overflow: auto; display: flex; justify-content: center; align-items: flex-start; }
  .lb-stage img { max-width: 100%; height: auto; box-shadow: 0 8px 30px rgba(0,0,0,0.45); background: #fff; }
</style>
</head>
<body>
<header class="topbar">
  <h1>Kinloom UI Review Contact Sheet</h1>
  <div class="topbar-meta">${safeTarget} &middot; ${safeTimestamp} &middot; ${manifest.summary.captured} captured / ${manifest.summary.skipped} skipped / ${manifest.summary.failed} failed${darkMetaSuffix}</div>
</header>
<div class="filters" role="region" aria-label="Screenshot filters">
  <div class="filter-group" role="group" aria-label="Category filter">
    <span class="filter-label">Category</span>
    <button type="button" class="pill active" data-filter-category="all">All (${manifest.summary.total})</button>
    <button type="button" class="pill" data-filter-category="page">Pages (${manifest.summary.byCategory.page})</button>
    <button type="button" class="pill" data-filter-category="component">Components (${manifest.summary.byCategory.component})</button>
    <button type="button" class="pill" data-filter-category="plugin">Plugins (${manifest.summary.byCategory.plugin})</button>
  </div>
  <div class="filter-group" role="group" aria-label="Viewport filter">
    <span class="filter-label">Viewport</span>
    <button type="button" class="pill active" data-filter-viewport="all">All</button>
    ${viewportButtons}
  </div>
  <div class="filter-group" role="group" aria-label="Theme filter">
    <span class="filter-label">Theme</span>
    <button type="button" class="pill active" data-filter-theme="all">All</button>
    ${themeButtons}
  </div>
  <div class="filter-group" role="group" aria-label="Status filter">
    <span class="filter-label">Status</span>
    <button type="button" class="pill active" data-filter-status="all">All</button>
    <button type="button" class="pill" data-filter-status="errors">Errors Only</button>
    <button type="button" class="pill" data-filter-status="skipped">Skipped</button>
  </div>
  <input id="searchBox" class="search-input" type="search" placeholder="Filter label, route, state..." aria-label="Filter screenshots" />
  <div id="visibleCount" class="stats"></div>
</div>
<main id="sheetMain">
${sectionsHtml}
</main>
<div id="lightbox" class="lightbox" role="dialog" aria-modal="true" aria-label="Screenshot zoom viewer">
  <div class="lb-bar">
    <div><div id="lbTitle" class="lb-title"></div><div id="lbMeta" class="lb-meta"></div></div>
    <div class="lb-actions">
      <button type="button" id="lbPrev" class="lb-btn">Prev</button>
      <button type="button" id="lbNext" class="lb-btn">Next</button>
      <a id="lbRaw" class="lb-btn" href="#" target="_blank" rel="noopener">Open PNG</a>
      <button type="button" id="lbClose" class="lb-btn">Close (Esc)</button>
    </div>
  </div>
  <div class="lb-stage"><img id="lbImg" src="" alt="" /></div>
</div>
<script>
(() => {
  const state = { category: 'all', viewport: 'all', theme: 'all', status: 'all', query: '' };
  const cards = Array.from(document.querySelectorAll('.card'));
  const groups = Array.from(document.querySelectorAll('.group'));
  const countEl = document.getElementById('visibleCount');
  const searchBox = document.getElementById('searchBox');
  const lb = document.getElementById('lightbox');
  const lbImg = document.getElementById('lbImg');
  const lbTitle = document.getElementById('lbTitle');
  const lbMeta = document.getElementById('lbMeta');
  const lbRaw = document.getElementById('lbRaw');
  let activeZoomButtons = [];
  let zoomIndex = -1;

  function applyFilters() {
    let shown = 0;
    for (const card of cards) {
      const matchCat = state.category === 'all' || card.dataset.category === state.category;
      const matchVp = state.viewport === 'all' || card.dataset.viewport === state.viewport;
      const matchTheme = state.theme === 'all' || card.dataset.theme === state.theme;
      const matchStatus = state.status === 'all'
        || (state.status === 'errors' && card.dataset.errors === '1')
        || (state.status === 'skipped' && card.dataset.status === 'skipped');
      const matchQ = !state.query || (card.dataset.search || '').includes(state.query);
      const visible = matchCat && matchVp && matchTheme && matchStatus && matchQ;
      card.hidden = !visible;
      if (visible) shown += 1;
    }
    for (const group of groups) {
      const anyVisible = Array.from(group.querySelectorAll('.card')).some((c) => !c.hidden);
      group.hidden = !anyVisible;
    }
    if (countEl) countEl.textContent = shown + ' / ' + cards.length + ' shown';
  }

  function wireGroup(attr, key) {
    const btns = Array.from(document.querySelectorAll('[' + attr + ']'));
    for (const btn of btns) {
      btn.addEventListener('click', () => {
        state[key] = btn.getAttribute(attr) || 'all';
        for (const other of btns) other.classList.toggle('active', other === btn);
        applyFilters();
      });
    }
  }
  wireGroup('data-filter-category', 'category');
  wireGroup('data-filter-viewport', 'viewport');
  wireGroup('data-filter-theme', 'theme');
  wireGroup('data-filter-status', 'status');
  if (searchBox) {
    searchBox.addEventListener('input', () => {
      state.query = searchBox.value.trim().toLowerCase();
      applyFilters();
    });
  }

  function showZoom(idx) {
    if (idx < 0 || idx >= activeZoomButtons.length) return;
    zoomIndex = idx;
    const btn = activeZoomButtons[idx];
    const src = btn.getAttribute('data-zoom-src') || '';
    lbImg.src = src;
    lbImg.alt = btn.getAttribute('data-zoom-title') || '';
    lbTitle.textContent = btn.getAttribute('data-zoom-title') || '';
    lbMeta.textContent = btn.getAttribute('data-zoom-meta') || '';
    lbRaw.href = src;
    lb.classList.add('open');
  }

  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.thumb-btn') : null;
    if (!btn) return;
    activeZoomButtons = Array.from(document.querySelectorAll('.card:not([hidden]) .thumb-btn'));
    showZoom(activeZoomButtons.indexOf(btn));
  });
  document.getElementById('lbClose')?.addEventListener('click', () => lb.classList.remove('open'));
  document.getElementById('lbPrev')?.addEventListener('click', () => {
    if (activeZoomButtons.length > 0) showZoom((zoomIndex - 1 + activeZoomButtons.length) % activeZoomButtons.length);
  });
  document.getElementById('lbNext')?.addEventListener('click', () => {
    if (activeZoomButtons.length > 0) showZoom((zoomIndex + 1) % activeZoomButtons.length);
  });
  document.addEventListener('keydown', (e) => {
    if (!lb.classList.contains('open')) return;
    if (e.key === 'Escape') lb.classList.remove('open');
    if (e.key === 'ArrowLeft' && activeZoomButtons.length > 0) showZoom((zoomIndex - 1 + activeZoomButtons.length) % activeZoomButtons.length);
    if (e.key === 'ArrowRight' && activeZoomButtons.length > 0) showZoom((zoomIndex + 1) % activeZoomButtons.length);
  });
  applyFilters();
})();
</script>
</body>
</html>
`;
}

export function formatScreenshotsTextReport(result: Omit<ScreenshotsCommandResult, 'rendered'>): string {
  const { summary, darkThemeVerification } = result.manifest;
  const lines = [
    `Kinloom UI Screenshots Export`,
    `  Target URL:    ${result.manifest.targetUrl}`,
    `  Output Dir:    ${result.outDir}`,
    `  Contact Sheet: ${result.indexHtmlPath}`,
    `  Manifest:      ${result.manifestPath}`,
    `  Viewports:     ${result.manifest.viewports.map((v) => `${v.name}:${v.width}x${v.height}`).join(', ')}`,
    `  Themes:        ${result.manifest.themes.join(', ')}`,
    `  Captures:      ${summary.captured} captured, ${summary.skipped} skipped, ${summary.failed} failed (${summary.total} total)`,
    `  Breakdown:     pages=${summary.byCategory.page}, components=${summary.byCategory.component}, plugins=${summary.byCategory.plugin}`,
    `  Diagnostics:   ${summary.consoleErrorCount} console error(s), ${summary.failedRequestCount} failed request(s)`,
  ];

  if (darkThemeVerification && darkThemeVerification.status !== 'not-requested') {
    const parts: string[] = [darkThemeVerification.status];
    if (darkThemeVerification.pairedCaptureCount > 0) {
      parts.push(
        `${darkThemeVerification.distinctFromLightCount}/${darkThemeVerification.pairedCaptureCount} distinct from light`
      );
    }
    if (darkThemeVerification.darkSurfaceVerifiedCount > 0) {
      parts.push(`${darkThemeVerification.darkSurfaceVerifiedCount} dark canvas`);
    }
    if (darkThemeVerification.lightCanvasInDarkModeCount > 0) {
      parts.push(`${darkThemeVerification.lightCanvasInDarkModeCount} light canvas in dark mode`);
    }
    if (darkThemeVerification.minDarkContrastRatio !== null) {
      parts.push(`min contrast ${darkThemeVerification.minDarkContrastRatio}:1`);
    }
    lines.push(`  Dark Theme:    ${parts.join(', ')}`);
  }

  const fallbackEntries = result.manifest.captures.filter(
    (entry) => entry.fallbackUsed === 'viewport-after-fullpage-timeout'
  );
  if (fallbackEntries.length > 0) {
    lines.push(
      `  Fallbacks:     ${fallbackEntries.length} viewport fallback(s) after full-page timeout (${fallbackEntries
        .slice(0, 5)
        .map((e) => `${e.route} ${e.viewport}/${e.theme}`)
        .join(', ')})`
    );
  }

  const failedEntries = result.manifest.captures.filter((entry) => entry.status === 'failed');
  if (failedEntries.length > 0) {
    lines.push('  Failures:');
    for (const entry of failedEntries.slice(0, 10)) {
      lines.push(
        `    - [${entry.category}] ${entry.route} (${entry.viewport}/${entry.theme}): ${entry.reason ?? 'capture failed'}`
      );
    }
  }
  return lines.join('\n');
}
