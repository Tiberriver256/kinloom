import {
  ARCHIVAL_LANDMASSES,
  type ArchiveBundle,
  buildMigrationStops,
  buildPerPersonMigrationSegments,
  computeStopsBounds,
  escapeXml,
  formatDeceasedLifespan,
  type KinloomSiteConfig,
  type KinshipEdge,
  type Person,
  projectLatLng,
  renderKinloomMarkPaths,
  resolveBrandSpec,
  type SourceRecord,
} from '@kinloom/core';
import { KINLOOM_SERVER_VERSION } from '../../version.js';
import {
  BOOK_TRIM_PRESETS,
  computeCoverDimensionsOffline,
  computeInteriorGeometry,
  evaluateImageDpi,
  normalizeBookPageCount,
  resolveLuluPodPackageId,
} from './geometry.js';
import { type RedactedBookArchive, runBookPrivacyGate } from './privacyGate.js';
import type {
  BookBindingStyle,
  BookBuildReport,
  BookBuildWarning,
  BookChapterSummary,
  BookCompiledPage,
  BookCompileOptions,
  BookImageDpiAudit,
  BookIndexEntry,
  BookPaperStock,
  BookPhysicalSpec,
  BookTrimPresetId,
  CompiledBookDocument,
  CoverDimensionsResult,
} from './types.js';

const DEFAULT_TRIM_PRESET: BookTrimPresetId = 'us-letter-landscape';
const DEFAULT_BINDING: BookBindingStyle = 'hardcover-casewrap-glossy';
const DEFAULT_PAPER_STOCK: BookPaperStock = '80lb-coated-white-color';
const DEFAULT_PHOTO_BOX_WIDTH_IN = 4.5;
const DEFAULT_PHOTO_BOX_HEIGHT_IN = 3.25;

function escapeHtml(text: string): string {
  return escapeXml(text);
}

function stripMarkdownToPlain(md: string): string {
  return md
    .replaceAll(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replaceAll(/^#{1,6}\s+/gm, '')
    .replaceAll(/[*_`~]/g, '')
    .replaceAll(/\r?\n{2,}/g, '\n')
    .trim();
}

function wrapLines(text: string, maxChars: number): string[] {
  const cleaned = text.replaceAll(/\s+/g, ' ').trim();
  if (!cleaned) {
    return [];
  }
  const words = cleaned.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= maxChars) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

function selectScopedPeople(
  archive: RedactedBookArchive,
  siteConfig: KinloomSiteConfig,
  branchId?: string,
  rootPersonId?: string
): readonly Person[] {
  let people = [...archive.people];

  if (branchId?.trim()) {
    const normalizedBranch = branchId.trim().toLowerCase();
    const configuredBranch = siteConfig.branches.find((b) => b.id.toLowerCase() === normalizedBranch);
    const allowedGroups = new Set((configuredBranch?.lineageGroups ?? []).map((g) => g.toLowerCase()));
    const allowedSurnames = new Set((configuredBranch?.surnames ?? []).map((s) => s.toLowerCase()));

    people = people.filter((person) => {
      if (person.branch?.toLowerCase() === normalizedBranch) {
        return true;
      }
      if (person.lineage_group.toLowerCase() === normalizedBranch) {
        return true;
      }
      if (allowedGroups.has(person.lineage_group.toLowerCase())) {
        return true;
      }
      if (allowedSurnames.has(person.surname.toLowerCase())) {
        return true;
      }
      return false;
    });
  }

  if (rootPersonId?.trim()) {
    const targetId = rootPersonId.trim();
    const parentsByChild = new Map<string, string[]>();
    for (const edge of archive.kinship) {
      if (edge.relation === 'parent') {
        const list = parentsByChild.get(edge.to) ?? [];
        list.push(edge.from);
        parentsByChild.set(edge.to, list);
      } else if (edge.relation === 'child') {
        const list = parentsByChild.get(edge.from) ?? [];
        list.push(edge.to);
        parentsByChild.set(edge.from, list);
      }
    }
    const ancestorIds = new Set<string>([targetId]);
    const queue = [targetId];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      for (const parentId of parentsByChild.get(current) ?? []) {
        if (!ancestorIds.has(parentId)) {
          ancestorIds.add(parentId);
          queue.push(parentId);
        }
      }
    }
    people = people.filter((p) => ancestorIds.has(p.id));
  }

  return people.toSorted((a, b) => {
    const yearA = a.birth_year ?? 9999;
    const yearB = b.birth_year ?? 9999;
    return yearA - yearB || a.surname.localeCompare(b.surname) || a.full_name.localeCompare(b.full_name);
  });
}

interface ChapterGroup {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly people: readonly Person[];
}

function groupPeopleIntoChapters(people: readonly Person[], siteConfig: KinloomSiteConfig): ChapterGroup[] {
  const assigned = new Set<string>();
  const chapters: ChapterGroup[] = [];

  for (const section of siteConfig.lineageSections) {
    const groupSet = new Set(section.lineageGroups.map((g) => g.toLowerCase()));
    const matched = people.filter((p) => {
      if (assigned.has(p.id)) {
        return false;
      }
      if (section.branchId && p.branch === section.branchId) {
        return true;
      }
      return groupSet.has(p.lineage_group.toLowerCase());
    });
    if (matched.length > 0) {
      for (const person of matched) {
        assigned.add(person.id);
      }
      chapters.push({
        id: section.id,
        title: section.title,
        subtitle: section.subtitle,
        people: matched,
      });
    }
  }

  const remaining = people.filter((p) => !assigned.has(p.id));
  if (remaining.length > 0) {
    chapters.push({
      id: chapters.length === 0 ? 'chronicle' : 'extended-lineage',
      title: chapters.length === 0 ? 'Family Chronicle' : 'Additional & Collateral Relatives',
      subtitle: 'Biographical dossiers ordered chronologically by birth year',
      people: remaining,
    });
  }

  return chapters;
}

function renderPedigreeSpreadSvg(people: readonly Person[], kinship: readonly KinshipEdge[]): string {
  const featured = people.slice(0, 12);
  const width = 920;
  const height = 420;
  const cols = 4;
  const cellW = 205;
  const cellH = 92;
  const gapX = 20;
  const gapY = 26;
  const startX = 20;
  const startY = 36;

  const positions = new Map<string, { x: number; y: number }>();
  const cards: string[] = [];

  featured.forEach((person, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = startX + col * (cellW + gapX);
    const y = startY + row * (cellH + gapY);
    positions.set(person.id, { x, y });
    const lifespan = formatDeceasedLifespan(person);
    cards.push(
      `<g>
        <rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="4" fill="#FCF9F2" stroke="#1B2A41" stroke-width="1.25" />
        <rect x="${x}" y="${y}" width="${cellW}" height="18" rx="4" fill="#1B2A41" />
        <text x="${x + 8}" y="${y + 13}" font-family="monospace" font-size="9" fill="#FCF9F2">${escapeXml(person.lineage_group.toUpperCase())}</text>
        <text x="${x + 8}" y="${y + 42}" font-family="serif" font-size="13" font-weight="700" fill="#1A1D23">${escapeXml(person.full_name.slice(0, 26))}</text>
        <text x="${x + 8}" y="${y + 62}" font-family="monospace" font-size="10" fill="#4E4A42">${escapeXml(lifespan)}</text>
        <text x="${x + 8}" y="${y + 79}" font-family="monospace" font-size="9" fill="#7A4612">${person.event_count} documented event(s)</text>
      </g>`
    );
  });

  const connectors: string[] = [];
  for (const edge of kinship) {
    if (edge.relation !== 'parent') {
      continue;
    }
    const fromPos = positions.get(edge.from);
    const toPos = positions.get(edge.to);
    if (!fromPos || !toPos) {
      continue;
    }
    const x1 = fromPos.x + cellW / 2;
    const y1 = fromPos.y + cellH;
    const x2 = toPos.x + cellW / 2;
    const y2 = toPos.y;
    const midY = Math.round((y1 + y2) / 2);
    connectors.push(
      `<path d="M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}" fill="none" stroke="#7A4612" stroke-width="1.4" stroke-dasharray="3 2" />`
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" class="book-pedigree-svg" role="img" aria-label="Generational pedigree chart">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#F8F4EA" stroke="#CBBFA8" stroke-width="1" />
    <text x="20" y="22" font-family="monospace" font-size="10" fill="#4E4A42">ORTHOGONAL GENERATIONAL PEDIGREE OVERVIEW (${featured.length} FEATURED RELATIVES)</text>
    ${connectors.join('\n    ')}
    ${cards.join('\n    ')}
  </svg>`;
}

function renderMigrationMapPlateSvg(
  archive: RedactedBookArchive,
  scopedPeople: readonly Person[],
  siteConfig: KinloomSiteConfig
): { readonly svg: string; readonly stopCount: number; readonly segmentCount: number } {
  const width = 920;
  const height = 420;
  const placesById = new Map(archive.places.map((place) => [place.id, place]));
  const peopleById = new Map(scopedPeople.map((person) => [person.id, person]));

  const syntheticBundle: ArchiveBundle = {
    meta: {
      build_mode: archive.edition,
      generated_at: '',
      counts: {
        people: scopedPeople.length,
        living_redacted: archive.excludedLivingPeopleCount,
        events: archive.events.length,
        residence_spans: archive.residenceSpans.length,
        places: archive.places.length,
        sources: archive.sources.length,
      },
    },
    people: [...scopedPeople],
    events: [...archive.events],
    residence_spans: [...archive.residenceSpans],
    places: [...archive.places],
    place_ancestors: {},
    kinship: [...archive.kinship],
    sources: [...archive.sources],
  };

  const stops = buildMigrationStops(syntheticBundle, placesById, peopleById, {
    migrationEras: siteConfig.migrationEras,
  });
  const segments = buildPerPersonMigrationSegments(stops);
  const rawBounds = computeStopsBounds(stops, siteConfig.mapDefaults);
  const bounds = rawBounds
    ? {
        minLng: rawBounds[0][0] - 2,
        minLat: rawBounds[0][1] - 1.5,
        maxLng: rawBounds[1][0] + 2,
        maxLat: rawBounds[1][1] + 1.5,
      }
    : { minLng: -104, maxLng: -68, minLat: 30, maxLat: 46 };

  const landPaths = ARCHIVAL_LANDMASSES.map((ring) => {
    const pts = ring.coords
      .map(([lng, lat]) => {
        const p = projectLatLng(lat, lng, bounds, width, height, 28);
        return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      })
      .join(' ');
    return `<polygon points="${pts}" fill="#EFE8D8" stroke="#C5B89E" stroke-width="0.9" />`;
  });

  const routeLines = segments.map((seg) => {
    const fromPt = projectLatLng(seg.from.place.lat, seg.from.place.lng, bounds, width, height, 28);
    const toPt = projectLatLng(seg.to.place.lat, seg.to.place.lng, bounds, width, height, 28);
    return `<line x1="${fromPt.x.toFixed(1)}" y1="${fromPt.y.toFixed(1)}" x2="${toPt.x.toFixed(1)}" y2="${toPt.y.toFixed(1)}" stroke="#7A4612" stroke-width="1.8" stroke-dasharray="4 3" />`;
  });

  const stopMarkers = stops.slice(0, 24).map((stop, idx) => {
    const pt = projectLatLng(stop.place.lat, stop.place.lng, bounds, width, height, 28);
    return `<g>
      <circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="4.5" fill="#1B2A41" stroke="#FCF9F2" stroke-width="1.2" />
      <text x="${(pt.x + 7).toFixed(1)}" y="${(pt.y + 3).toFixed(1)}" font-family="monospace" font-size="9" fill="#1A1D23">${idx + 1}. ${escapeXml(stop.place.name)} (${stop.year})</text>
    </g>`;
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" class="book-map-svg" role="img" aria-label="Historical migration map plate">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#E6ECF0" stroke="#1B2A41" stroke-width="1.2" />
    ${landPaths.join('\n    ')}
    ${routeLines.join('\n    ')}
    ${stopMarkers.join('\n    ')}
    <text x="16" y="${height - 12}" font-family="monospace" font-size="9" fill="#4E4A42">OFFLINE VECTOR MIGRATION PLATE · ${stops.length} DOCUMENTED STOPS · ${segments.length} PER-PERSON LEGS</text>
  </svg>`;

  return { svg, stopCount: stops.length, segmentCount: segments.length };
}

export function renderBookCoverHtml(params: {
  readonly title: string;
  readonly subtitle: string;
  readonly familyName: string;
  readonly colophonNotice: string;
  readonly coverDimensions: CoverDimensionsResult;
  readonly accentColor: string;
  readonly proofMarks: boolean;
}): string {
  const { title, subtitle, familyName, colophonNotice, coverDimensions, accentColor, proofMarks } = params;
  const trimW =
    (coverDimensions.totalWidthIn - 2 * coverDimensions.wrapAllowanceIn - coverDimensions.spineWidthIn) / 2;
  const trimH = coverDimensions.totalHeightIn - 2 * coverDimensions.wrapAllowanceIn;
  const wrap = coverDimensions.wrapAllowanceIn;
  const spineW = coverDimensions.spineWidthIn;
  const barcode = coverDimensions.barcodeClearanceIn;

  const spineMarkup = coverDimensions.allowSpineText
    ? `<div class="cover-spine-text" data-spine-text="enabled">${escapeHtml(title)} — ${escapeHtml(familyName)}</div>`
    : '<!-- Spine text intentionally omitted below 80 pages / 0.375 in spine threshold -->';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)} — Hardcover Wraparound Cover</title>
  <style>
    @page {
      size: ${coverDimensions.totalWidthIn}in ${coverDimensions.totalHeightIn}in;
      margin: 0;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: ${coverDimensions.totalWidthIn}in;
      height: ${coverDimensions.totalHeightIn}in;
      background: #1B2A41;
      color: #FCF9F2;
      font-family: Georgia, "Times New Roman", serif;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .cover-spread {
      position: relative;
      width: ${coverDimensions.totalWidthIn}in;
      height: ${coverDimensions.totalHeightIn}in;
      overflow: hidden;
      background: #1B2A41;
    }
    .cover-panel {
      position: absolute;
      top: ${wrap}in;
      height: ${trimH.toFixed(3)}in;
    }
    .cover-back {
      left: ${wrap}in;
      width: ${trimW.toFixed(3)}in;
      padding: 0.9in;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .cover-spine {
      left: ${(wrap + trimW).toFixed(3)}in;
      width: ${spineW.toFixed(3)}in;
      border-left: 1px solid rgba(252, 249, 242, 0.16);
      border-right: 1px solid rgba(252, 249, 242, 0.16);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .cover-spine-text {
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      font-size: ${Math.min(11, Math.max(7, Math.floor(coverDimensions.maxSpineTextHeightIn * 44)))}pt;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #F5EFE2;
      white-space: nowrap;
    }
    .cover-front {
      left: ${(wrap + trimW + spineW).toFixed(3)}in;
      width: ${trimW.toFixed(3)}in;
      padding: 1.1in;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      align-items: center;
      text-align: center;
    }
    .cover-frame {
      width: 100%;
      height: 100%;
      border: 2px solid ${escapeHtml(accentColor)};
      padding: 0.75in;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      align-items: center;
    }
    .cover-eyebrow {
      font-family: "Courier New", monospace;
      font-size: 9pt;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: #E2C799;
    }
    .cover-title {
      font-size: 32pt;
      line-height: 1.15;
      margin: 0.25in 0 0.15in;
      color: #FCF9F2;
    }
    .cover-subtitle {
      font-size: 13pt;
      font-style: italic;
      color: #E8DFCE;
      margin: 0;
    }
    .cover-emblem {
      width: 72px;
      height: 72px;
    }
    .cover-barcode-safe {
      position: absolute;
      left: ${barcode.xIn}in;
      bottom: ${barcode.yIn}in;
      width: ${barcode.widthIn}in;
      height: ${barcode.heightIn}in;
      ${proofMarks ? 'border: 1px dashed rgba(252, 249, 242, 0.55);' : ''}
    }
    .cover-colophon {
      font-family: "Courier New", monospace;
      font-size: 8.5pt;
      line-height: 1.5;
      color: #D8D1C2;
      max-width: 5.8in;
    }
  </style>
</head>
<body>
  <div class="cover-spread" data-sku="${escapeHtml(coverDimensions.providerSku)}" data-spine-in="${coverDimensions.spineWidthIn}">
    <section class="cover-panel cover-back" aria-label="Back cover">
      <div>
        <div class="cover-eyebrow">${escapeHtml(familyName)}</div>
        <p class="cover-colophon">${escapeHtml(subtitle)}</p>
      </div>
      <p class="cover-colophon">${escapeHtml(colophonNotice)}</p>
    </section>
    <section class="cover-panel cover-spine" aria-label="Book spine">
      ${spineMarkup}
    </section>
    <section class="cover-panel cover-front" aria-label="Front cover">
      <div class="cover-frame">
        <div class="cover-eyebrow">${escapeHtml(familyName)} · Archival Edition</div>
        <div>
          <svg class="cover-emblem" viewBox="0 0 64 64" aria-hidden="true">
            ${renderKinloomMarkPaths(accentColor, '#FCF9F2')}
          </svg>
          <h1 class="cover-title">${escapeHtml(title)}</h1>
          <p class="cover-subtitle">${escapeHtml(subtitle)}</p>
        </div>
        <div class="cover-eyebrow">Kinloom Archival Press</div>
      </div>
    </section>
    <div class="cover-barcode-safe" aria-hidden="true"></div>
  </div>
</body>
</html>`;
}

/**
 * Pure archival landscape book compiler.
 * Enforces the mandatory living-person privacy gate before generating structured pages,
 * prepress geometry, DPI audits, interior HTML+SVG, and wraparound cover HTML.
 */
export function compileArchivalBook(params: {
  readonly bundle: ArchiveBundle;
  readonly siteConfig: KinloomSiteConfig;
  readonly options?: BookCompileOptions;
}): CompiledBookDocument {
  const opts = params.options ?? {};
  const edition = opts.edition ?? 'public';
  const generatedAt = opts.generatedAtIso ?? params.bundle.meta.generated_at ?? '2026-01-01T00:00:00.000Z';
  const parsedYear = Number.parseInt(generatedAt.slice(0, 4), 10);
  const referenceYear =
    opts.referenceYear ??
    params.siteConfig.privacy.referenceYear ??
    (Number.isInteger(parsedYear) && parsedYear >= 1900 ? parsedYear : 2026);

  const redacted = runBookPrivacyGate({
    bundle: params.bundle,
    siteConfig: params.siteConfig,
    edition,
    includeLiving: opts.includeLiving,
    allowLivingPortraits: opts.allowLivingPortraits,
    acknowledgeReviewFlags: opts.acknowledgeReviewFlags,
    referenceYear,
    dedication: opts.dedication,
  });

  const brand = resolveBrandSpec(params.siteConfig);
  const title = opts.title?.trim() || brand.title;
  const subtitle = opts.subtitle?.trim() || brand.subtitle;
  const familyName = params.siteConfig.site.familyName;
  const trimPreset = opts.trimPreset ?? DEFAULT_TRIM_PRESET;
  const binding = opts.binding ?? DEFAULT_BINDING;
  const paperStock = opts.paperStock ?? DEFAULT_PAPER_STOCK;
  const proofMarks = opts.proofMarks === true;

  const scopedPeople = selectScopedPeople(redacted, params.siteConfig, opts.branchId, opts.rootPersonId);
  const scopedPersonIds = new Set(scopedPeople.map((p) => p.id));
  const placesById = new Map(redacted.places.map((p) => [p.id, p]));
  const sourcesById = new Map(redacted.sources.map((s) => [s.id, s]));

  const scopedEvents = redacted.events
    .filter(
      (ev) => ev.participants.length === 0 || ev.participants.some((pt) => scopedPersonIds.has(pt.person_id))
    )
    .toSorted((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.title.localeCompare(b.title));

  const scopedMedia = redacted.media.filter((item) => {
    const linked = [...(item.person_id ? [item.person_id] : []), ...(item.person_ids ?? [])];
    return linked.length === 0 || linked.some((id) => scopedPersonIds.has(id));
  });

  const scopedNarratives = redacted.narratives.filter(
    (n) =>
      (n.subject_person_id && scopedPersonIds.has(n.subject_person_id)) ||
      n.person_ids.some((id) => scopedPersonIds.has(id))
  );

  // Citation numbering map (1-based endnotes).
  const citationNumbers = new Map<string, number>();
  const citedSourcesOrdered: SourceRecord[] = [];
  const registerSource = (sourceId: string): number | null => {
    const src = sourcesById.get(sourceId);
    if (!src) {
      return null;
    }
    const existing = citationNumbers.get(sourceId);
    if (existing !== undefined) {
      return existing;
    }
    const nextNum = citedSourcesOrdered.length + 1;
    citationNumbers.set(sourceId, nextNum);
    citedSourcesOrdered.push(src);
    return nextNum;
  };

  // Pre-audit raster image resolutions when pixel dimensions are known.
  const imageAudits: BookImageDpiAudit[] = [];
  const warnings: BookBuildWarning[] = [];
  if (redacted.reviewFlagsAcknowledged) {
    warnings.push({
      code: 'privacy_review_acknowledged',
      message: `${redacted.reviewFlags.length} living-person review flag(s) were explicitly acknowledged for this build.`,
    });
  }

  for (const item of scopedMedia) {
    const dims = opts.imageDimensionsByFile?.[item.file];
    if (!dims) {
      continue;
    }
    const audit = evaluateImageDpi({
      mediaId: item.id,
      file: item.file,
      widthPx: dims.widthPx,
      heightPx: dims.heightPx,
      placedWidthIn: DEFAULT_PHOTO_BOX_WIDTH_IN,
      placedHeightIn: DEFAULT_PHOTO_BOX_HEIGHT_IN,
    });
    imageAudits.push(audit);
    if (audit.status === 'low') {
      warnings.push({
        code: 'low_resolution_image',
        entityId: item.id,
        message: `Media ${item.id} (${item.file}) is ${audit.effectiveDpi} DPI at ${audit.placedWidthIn}x${audit.placedHeightIn} in; recommended frame ${audit.recommendedWidthIn}x${audit.recommendedHeightIn} in.`,
      });
    } else if (audit.status === 'warn') {
      warnings.push({
        code: 'medium_resolution_image',
        entityId: item.id,
        message: `Media ${item.id} (${item.file}) is ${audit.effectiveDpi} DPI (200-299 DPI archival scan warning).`,
      });
    }
  }

  const indexPageMap = new Map<string, { category: 'person' | 'place'; term: string; pages: Set<number> }>();
  const recordIndexTerm = (category: 'person' | 'place', term: string, pageNumber: number): void => {
    const clean = term.trim();
    if (!clean) {
      return;
    }
    const key = `${category}:${clean.toLowerCase()}`;
    const existing = indexPageMap.get(key);
    if (existing) {
      existing.pages.add(pageNumber);
    } else {
      indexPageMap.set(key, { category, term: clean, pages: new Set([pageNumber]) });
    }
  };

  const pages: BookCompiledPage[] = [];
  const pushPage = (page: Omit<BookCompiledPage, 'pageNumber'>): number => {
    const pageNumber = pages.length + 1;
    pages.push({ pageNumber, ...page });
    return pageNumber;
  };

  // Page 1: Half-Title
  pushPage({
    kind: 'half-title',
    sectionTitle: 'Front Matter',
    heading: title,
    subtitle: `${familyName} Archival Volume`,
    lines: [subtitle],
    footnotes: [],
  });

  // Page 2: Full Title Page
  pushPage({
    kind: 'title',
    sectionTitle: 'Front Matter',
    heading: title,
    subtitle,
    lines: [
      `Family Archive: ${familyName}`,
      `Edition: ${edition === 'private' ? 'Private Family Edition' : 'Public Redacted Edition'}`,
      `Compiled: ${generatedAt.slice(0, 10)}`,
      ...(opts.branchId ? [`Branch Scope: ${opts.branchId}`] : []),
      ...(opts.rootPersonId ? [`Ancestor Scope Root: ${opts.rootPersonId}`] : []),
    ],
    footnotes: [redacted.colophonNotice],
  });

  // Page 3: Dedication (when provided) & Archival Preface
  if (redacted.dedication) {
    pushPage({
      kind: 'dedication',
      sectionTitle: 'Dedication',
      heading: 'Dedication',
      lines: wrapLines(redacted.dedication, 84),
      footnotes: [],
    });
  }

  // Reserve Page for Table of Contents (filled once chapter pages are known)
  const tocPageIndex = pages.length;
  pushPage({
    kind: 'toc',
    sectionTitle: 'Table of Contents',
    heading: 'Table of Contents',
    lines: [],
    footnotes: [],
  });

  // Preface & Provenance Methodology
  pushPage({
    kind: 'preface',
    sectionTitle: 'Archival Preface',
    heading: 'Archival Preface & Provenance Methodology',
    lines: [
      ...wrapLines(brand.description, 92),
      '',
      `Documented Relatives Included: ${scopedPeople.length}`,
      `Documented Places: ${redacted.places.length}`,
      `Primary Sources Catalogued: ${redacted.sources.length}`,
      `Photographic & Document Plates: ${scopedMedia.length}`,
      '',
      'Citation Confidence Legend:',
      '  Confirmed — Grounded in primary civil, census, vital, or archival records.',
      '  Inferred  — Derived from corroborating family records and chronology.',
      '  Possible  — Working hypothesis retained for future verification.',
    ],
    footnotes: [redacted.colophonNotice],
  });

  // Family Overview & Chronological Timeline Summary
  const earliestYear = scopedEvents.find((e) => e.year !== null)?.year ?? null;
  const latestYear = [...scopedEvents].reverse().find((e) => e.year !== null)?.year ?? null;
  const timelineHighlights = scopedEvents.slice(0, 12).map((ev) => {
    const placeName = ev.place_id ? placesById.get(ev.place_id)?.name : undefined;
    return `${ev.display_date || ev.edtf_date || 'Undated'} — ${ev.title}${placeName ? ` (${placeName})` : ''}`;
  });
  pushPage({
    kind: 'overview',
    sectionTitle: 'Family Overview',
    heading: 'Family Overview & Historical Timeline',
    subtitle:
      earliestYear !== null && latestYear !== null
        ? `Documented span: ${earliestYear} to ${latestYear}`
        : 'Chronological archival summary',
    lines:
      timelineHighlights.length > 0
        ? timelineHighlights
        : ['No chronological family milestones recorded in this scope.'],
    footnotes: [],
  });

  // Generational Pedigree Spread (2 pages in landscape spread)
  const pedigreeSvg = renderPedigreeSpreadSvg(scopedPeople, redacted.kinship);
  pushPage({
    kind: 'pedigree',
    sectionTitle: 'Generational Pedigree',
    heading: 'Generational Pedigree Chart (Spread — Left)',
    subtitle: `${scopedPeople.length} relatives across ${redacted.kinship.length} documented kinship links`,
    lines: scopedPeople.slice(0, 10).map((p) => `${p.full_name} (${formatDeceasedLifespan(p)})`),
    footnotes: [],
  });
  pushPage({
    kind: 'pedigree',
    sectionTitle: 'Generational Pedigree',
    heading: 'Generational Pedigree Chart (Spread — Right)',
    subtitle: 'Orthogonal lineage view',
    lines: scopedPeople.slice(10, 20).map((p) => `${p.full_name} (${formatDeceasedLifespan(p)})`),
    footnotes: [],
  });

  // Chapter-by-Chapter Ancestor Biographies & Photo Plates
  const chapters = groupPeopleIntoChapters(scopedPeople, params.siteConfig);
  const chapterSummaries: BookChapterSummary[] = [];

  for (const chapter of chapters) {
    const chapterStartPage = pushPage({
      kind: 'chapter-opener',
      sectionTitle: chapter.title,
      heading: chapter.title,
      subtitle: chapter.subtitle ?? `${chapter.people.length} biographical dossier(s)`,
      lines: chapter.people.map((p) => `${p.full_name} (${formatDeceasedLifespan(p)})`),
      footnotes: [],
    });

    let chapterMediaCount = 0;

    for (const person of chapter.people) {
      const personEvents = scopedEvents.filter((ev) =>
        ev.participants.some((pt) => pt.person_id === person.id)
      );
      const personNarratives = scopedNarratives.filter(
        (n) => n.subject_person_id === person.id || n.person_ids.includes(person.id)
      );
      const personMedia = scopedMedia.filter(
        (m) => m.person_id === person.id || (m.person_ids ?? []).includes(person.id)
      );
      chapterMediaCount += personMedia.length;

      const pageFootnotes: string[] = [];
      const bioLines: string[] = [
        `Lifespan: ${formatDeceasedLifespan(person)}`,
        ...(person.primary_place_id && placesById.get(person.primary_place_id)
          ? [`Primary Place: ${placesById.get(person.primary_place_id)?.full_name ?? ''}`]
          : []),
      ];

      for (const narrative of personNarratives) {
        const citeNums = narrative.source_ids
          .map((sid) => registerSource(sid))
          .filter((n): n is number => n !== null);
        const citeSuffix = citeNums.length > 0 ? ` [${citeNums.join(', ')}]` : '';
        bioLines.push('');
        bioLines.push(`${narrative.title}${citeSuffix}`);
        bioLines.push(...wrapLines(stripMarkdownToPlain(narrative.body_md), 92).slice(0, 12));
        for (const num of citeNums) {
          const src = citedSourcesOrdered[num - 1];
          if (src) {
            pageFootnotes.push(`[${num}] ${src.citation}`);
          }
        }
      }

      if (personEvents.length > 0) {
        bioLines.push('');
        bioLines.push('Chronological Life Events:');
        for (const ev of personEvents.slice(0, 10)) {
          const place = ev.place_id ? placesById.get(ev.place_id) : undefined;
          const citeNums = ev.sources
            .map((ref) => registerSource(ref.source_id))
            .filter((n): n is number => n !== null);
          const citeSuffix = citeNums.length > 0 ? ` [${citeNums.join(', ')}]` : '';
          bioLines.push(
            `  • ${ev.display_date || ev.edtf_date || 'Undated'}: ${ev.title}${place ? ` — ${place.name}` : ''}${citeSuffix}`
          );
          if (ev.summary) {
            bioLines.push(...wrapLines(`    ${ev.summary}`, 88).slice(0, 3));
          }
          for (const num of citeNums) {
            const src = citedSourcesOrdered[num - 1];
            if (src && !pageFootnotes.some((f) => f.startsWith(`[${num}] `))) {
              pageFootnotes.push(`[${num}] ${src.citation}`);
            }
          }
        }
      }

      const bioPageNumber = pushPage({
        kind: 'biography',
        sectionTitle: chapter.title,
        heading: person.full_name,
        subtitle: formatDeceasedLifespan(person),
        lines: bioLines,
        footnotes: pageFootnotes.slice(0, 6),
      });

      recordIndexTerm(
        'person',
        person.surname ? `${person.surname}, ${person.given_name}` : person.full_name,
        bioPageNumber
      );
      for (const ev of personEvents) {
        const place = ev.place_id ? placesById.get(ev.place_id) : undefined;
        if (place) {
          recordIndexTerm('place', place.full_name, bioPageNumber);
        }
      }

      if (personMedia.length > 0) {
        const plateLines = personMedia.flatMap((m) => [
          `Plate ${m.id}: ${m.caption}`,
          `  File: ${m.file}${m.date_edtf ? ` · Date: ${m.date_edtf}` : ''}${m.provenance ? ` · Provenance: ${m.provenance}` : ''}`,
        ]);
        const platePage = pushPage({
          kind: 'photo-plate',
          sectionTitle: `${chapter.title} · Photo Plates`,
          heading: `Archival Plates — ${person.full_name}`,
          subtitle: `${personMedia.length} primary photographic/document plate(s)`,
          lines: plateLines,
          footnotes: [],
        });
        recordIndexTerm(
          'person',
          person.surname ? `${person.surname}, ${person.given_name}` : person.full_name,
          platePage
        );
      }
    }

    chapterSummaries.push({
      id: chapter.id,
      title: chapter.title,
      startPage: chapterStartPage,
      personCount: chapter.people.length,
      mediaCount: chapterMediaCount,
    });
  }

  // Place Gazetteer & Migration Map Plate
  const gazetteerPlaces = redacted.places
    .filter((p) => p.place_type !== 'country')
    .toSorted((a, b) => a.full_name.localeCompare(b.full_name));

  const gazetteerStartPage = pushPage({
    kind: 'gazetteer',
    sectionTitle: 'Place Gazetteer',
    heading: 'Historical Place Gazetteer',
    subtitle: `${gazetteerPlaces.length} documented location(s)`,
    lines:
      gazetteerPlaces.length > 0
        ? gazetteerPlaces.slice(0, 18).map((p) => {
            const coords = `${p.lat.toFixed(3)}, ${p.lng.toFixed(3)}`;
            const summaryPart = p.summary ? ` — ${p.summary.slice(0, 90)}` : '';
            return `${p.full_name} [${p.place_type}; ${coords}]${summaryPart}`;
          })
        : ['No places documented in this archive scope.'],
    footnotes: [],
  });
  for (const place of gazetteerPlaces.slice(0, 18)) {
    recordIndexTerm('place', place.full_name, gazetteerStartPage);
  }

  const migrationPlate = renderMigrationMapPlateSvg(redacted, scopedPeople, params.siteConfig);
  const mapPageNumber = pushPage({
    kind: 'migration-map',
    sectionTitle: 'Migration Map Plate',
    heading: 'Regional Migration Map Plate',
    subtitle: `${migrationPlate.stopCount} chronological stops · ${migrationPlate.segmentCount} per-person journeys`,
    lines: [
      `Vector map plate compiled offline with zero network map-tile dependencies.`,
      `Stops plotted: ${migrationPlate.stopCount}`,
      `Documented migration legs: ${migrationPlate.segmentCount}`,
    ],
    footnotes: [],
  });

  // Include any remaining unreferenced sources in the bibliography as well so nothing is lost
  for (const src of redacted.sources) {
    registerSource(src.id);
  }

  const endnotesStartPage = pushPage({
    kind: 'endnotes',
    sectionTitle: 'Source Endnotes',
    heading: 'Source Citations & Provenance Endnotes',
    subtitle: `${citedSourcesOrdered.length} archival source(s)`,
    lines:
      citedSourcesOrdered.length > 0
        ? citedSourcesOrdered.map((src, idx) => {
            const meta = [src.author, src.publisher, src.repository].filter(Boolean).join(' · ');
            return `[${idx + 1}] ${src.citation}${meta ? ` (${meta})` : ''}`;
          })
        : ['No archival sources recorded.'],
    footnotes: [],
  });

  // Back-of-Book Alphabetical Surname & Place Index
  const indexEntries: BookIndexEntry[] = [...indexPageMap.values()]
    .map((entry) => ({
      term: entry.term,
      category: entry.category,
      pages: [...entry.pages].toSorted((a, b) => a - b),
    }))
    .toSorted((a, b) => a.term.localeCompare(b.term) || a.category.localeCompare(b.category));

  const indexStartPage = pushPage({
    kind: 'index',
    sectionTitle: 'Back-of-Book Index',
    heading: 'Surname & Place Index',
    subtitle: `${indexEntries.length} indexed entry(s)`,
    lines:
      indexEntries.length > 0
        ? indexEntries.map(
            (entry) => `${entry.term} (${entry.category}) .......... ${entry.pages.join(', ')}`
          )
        : ['No indexed entries.'],
    footnotes: [],
  });

  // Colophon Page
  const colophonPageNumber = pushPage({
    kind: 'colophon',
    sectionTitle: 'Colophon',
    heading: 'Colophon',
    lines: [
      `Title: ${title}`,
      `Archive: ${familyName}`,
      `Trim Size: ${BOOK_TRIM_PRESETS[trimPreset].label}`,
      `Binding: ${binding}`,
      `Paper Stock: ${paperStock}`,
      `Generated By: Kinloom ${KINLOOM_SERVER_VERSION}`,
      `Edition Date: ${generatedAt}`,
      redacted.colophonNotice,
    ],
    footnotes: [],
  });

  // Populate TOC now that every section page number is fixed
  const tocLines: string[] = [
    `Archival Preface & Methodology .......... p. ${tocPageIndex + 2}`,
    `Family Overview & Timeline .............. p. ${tocPageIndex + 3}`,
    `Generational Pedigree Spread ............ p. ${tocPageIndex + 4}`,
    ...chapterSummaries.map(
      (ch) => `Chapter: ${ch.title} (${ch.personCount} people) .......... p. ${ch.startPage}`
    ),
    `Historical Place Gazetteer .............. p. ${gazetteerStartPage}`,
    `Regional Migration Map Plate ............ p. ${mapPageNumber}`,
    `Source Citations & Endnotes ............. p. ${endnotesStartPage}`,
    `Surname & Place Index ................... p. ${indexStartPage}`,
    `Colophon ................................ p. ${colophonPageNumber}`,
  ];
  pages[tocPageIndex] = {
    ...pages[tocPageIndex],
    lines: tocLines,
  };

  // Enforce hardcover minimum 24 pages & even page count
  const rawContentPages = pages.length;
  const pageCountNorm = normalizeBookPageCount(rawContentPages);
  for (let i = 0; i < pageCountNorm.ledgerPages; i += 1) {
    pushPage({
      kind: 'notes-ledger',
      sectionTitle: 'Family Notes & Provenance Ledger',
      heading: 'Family Notes & Provenance Ledger',
      subtitle: 'Ruled archival leaf for handwritten annotations and family provenance',
      lines: Array.from(
        { length: 10 },
        () => '__________________________________________________________________________'
      ),
      footnotes: [],
    });
  }
  if (pageCountNorm.versoPad) {
    pushPage({
      kind: 'blank-verso',
      sectionTitle: 'Endpaper',
      heading: '',
      lines: [],
      footnotes: [],
    });
  }

  const spec: BookPhysicalSpec = {
    trimPreset,
    binding,
    paperStock,
    interiorPageCount: pageCountNorm.finalPages,
  };
  const interiorGeometry = computeInteriorGeometry(spec);
  const coverDimensions = computeCoverDimensionsOffline(spec, resolveLuluPodPackageId(spec));

  const renderPageHtml = (page: BookCompiledPage): string => {
    const isPedigreeLeft = page.kind === 'pedigree' && page.heading.includes('Left');
    const isMigrationMap = page.kind === 'migration-map';
    const extraVisual = isPedigreeLeft
      ? `<div class="book-plate-frame">${pedigreeSvg}</div>`
      : isMigrationMap
        ? `<div class="book-plate-frame">${migrationPlate.svg}</div>`
        : '';
    const bodyMarkup = page.lines
      .map((line) =>
        line === '' ? '<div class="book-spacer"></div>' : `<p class="book-line">${escapeHtml(line)}</p>`
      )
      .join('\n');
    const footnotesMarkup =
      page.footnotes.length > 0
        ? `<footer class="book-footnotes">${page.footnotes.map((fn) => `<div>${escapeHtml(fn)}</div>`).join('')}</footer>`
        : '';

    return `<section class="book-page book-page-${page.kind}" data-page-number="${page.pageNumber}">
      <header class="book-running-head">
        <span>${escapeHtml(title)}</span>
        <span>${escapeHtml(page.sectionTitle)}</span>
      </header>
      ${page.heading ? `<h2 class="book-page-heading">${escapeHtml(page.heading)}</h2>` : ''}
      ${page.subtitle ? `<p class="book-page-subtitle">${escapeHtml(page.subtitle)}</p>` : ''}
      ${extraVisual}
      <div class="book-page-body">${bodyMarkup}</div>
      ${footnotesMarkup}
      <div class="book-folio">${page.pageNumber}</div>
    </section>`;
  };

  const bleedOuterTopBottom = interiorGeometry.safetyMarginIn + interiorGeometry.bleedIn;
  const bleedInsideGutter = interiorGeometry.insideGutterIn + interiorGeometry.bleedIn;

  const interiorHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)} — Archival Interior</title>
  <style>
    @page {
      size: ${interiorGeometry.bleedWidthIn}in ${interiorGeometry.bleedHeightIn}in;
      margin: ${bleedOuterTopBottom}in;
    }
    @page :left {
      margin-left: ${bleedOuterTopBottom}in;
      margin-right: ${bleedInsideGutter}in;
    }
    @page :right {
      margin-left: ${bleedInsideGutter}in;
      margin-right: ${bleedOuterTopBottom}in;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #FCF9F2;
      color: #1A1D23;
      font-family: Georgia, "Times New Roman", serif;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .book-page {
      position: relative;
      width: ${interiorGeometry.bleedWidthIn}in;
      min-height: ${interiorGeometry.bleedHeightIn}in;
      padding: ${bleedOuterTopBottom}in ${bleedInsideGutter}in;
      page-break-after: always;
      break-after: page;
      background: #FCF9F2;
      ${proofMarks ? `outline: 1px dashed #7A4612; outline-offset: -${interiorGeometry.bleedIn}in;` : ''}
    }
    .book-running-head {
      display: flex;
      justify-content: space-between;
      font-family: "Courier New", monospace;
      font-size: 8.5pt;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #4E4A42;
      border-bottom: 1px solid #CBBFA8;
      padding-bottom: 6pt;
      margin-bottom: 14pt;
    }
    .book-page-heading {
      margin: 0 0 6pt;
      font-size: 20pt;
      color: #1B2A41;
    }
    .book-page-subtitle {
      margin: 0 0 12pt;
      font-style: italic;
      color: #4E4A42;
      font-size: 11pt;
    }
    .book-page-body {
      column-count: 2;
      column-gap: 0.35in;
      font-size: 10pt;
      line-height: 1.48;
    }
    .book-page-half-title .book-page-body,
    .book-page-title .book-page-body,
    .book-page-pedigree .book-page-body,
    .book-page-migration-map .book-page-body,
    .book-page-notes-ledger .book-page-body {
      column-count: 1;
    }
    .book-line {
      margin: 0 0 4pt;
    }
    .book-spacer {
      height: 8pt;
    }
    .book-plate-frame {
      margin: 8pt 0 12pt;
    }
    .book-pedigree-svg,
    .book-map-svg {
      width: 100%;
      height: auto;
      display: block;
    }
    .book-footnotes {
      margin-top: 12pt;
      padding-top: 6pt;
      border-top: 1px solid #CBBFA8;
      font-family: "Courier New", monospace;
      font-size: 8pt;
      color: #4E4A42;
    }
    .book-folio {
      position: absolute;
      bottom: ${bleedOuterTopBottom * 0.6}in;
      right: ${bleedOuterTopBottom}in;
      font-family: "Courier New", monospace;
      font-size: 9pt;
      color: #4E4A42;
    }
  </style>
</head>
<body data-edition="${edition}" data-trim="${trimPreset}" data-pages="${pageCountNorm.finalPages}">
  ${pages.map(renderPageHtml).join('\n')}
</body>
</html>`;

  const coverHtml = renderBookCoverHtml({
    title,
    subtitle,
    familyName,
    colophonNotice: redacted.colophonNotice,
    coverDimensions,
    accentColor: brand.accent,
    proofMarks,
  });

  const report: BookBuildReport = {
    title,
    subtitle,
    familyName,
    edition,
    colophonNotice: redacted.colophonNotice,
    generatedAt,
    scope: {
      branchId: opts.branchId?.trim() || null,
      rootPersonId: opts.rootPersonId?.trim() || null,
    },
    counts: {
      includedPeople: scopedPeople.length,
      excludedLivingPeople: redacted.excludedLivingPeopleCount,
      includedEvents: scopedEvents.length,
      includedPlaces: redacted.places.length,
      includedSources: citedSourcesOrdered.length,
      includedMedia: scopedMedia.length,
      excludedLivingMedia: redacted.excludedLivingMediaCount,
      includedNarratives: scopedNarratives.length,
      rawContentPages,
      paddingPages: pageCountNorm.paddingPages,
      finalPageCount: pageCountNorm.finalPages,
    },
    spec,
    interiorGeometry,
    coverDimensions,
    chapters: chapterSummaries,
    imageAudits,
    warnings,
    privacy: {
      edition,
      livingPeopleExcluded: redacted.excludedLivingPeopleCount,
      livingMediaExcluded: redacted.excludedLivingMediaCount,
      reviewFlagsDetected: redacted.reviewFlags.length,
      reviewFlagsAcknowledged: redacted.reviewFlagsAcknowledged,
    },
  };

  return {
    report,
    pages,
    indexEntries,
    interiorHtml,
    coverHtml,
  };
}
